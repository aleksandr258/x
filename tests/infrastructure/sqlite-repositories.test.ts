import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrations.js';
import { SqliteAccountRepository } from '../../src/infrastructure/persistence/sqlite-account-repository.js';
import { SqliteDatabase } from '../../src/infrastructure/persistence/sqlite-database.js';
import { SqliteKeywordRepository } from '../../src/infrastructure/persistence/sqlite-keyword-repository.js';
import { SqliteSeenTweetRepository } from '../../src/infrastructure/persistence/sqlite-seen-tweet-repository.js';
import { SqliteSyncStateRepository } from '../../src/infrastructure/persistence/sqlite-sync-state-repository.js';
import { MockTwitterProvider } from '../../src/infrastructure/twitter/mock-twitter-provider.js';
import { PayloadNormalizer } from '../../src/infrastructure/twitter/payload-normalizer.js';
import { RateLimitedHttpClient } from '../../src/infrastructure/twitter/rate-limited-http-client.js';
import { TwitterApiIoProvider } from '../../src/infrastructure/twitter/twitter-api-io-provider.js';

describe('SQLite Persistence, Migrations & Provider Adapters', () => {
  let sqliteDb: SqliteDatabase;

  beforeEach(() => {
    sqliteDb = new SqliteDatabase(':memory:');
  });

  afterEach(() => {
    sqliteDb.close();
  });

  it('applies migrations idempotently and heals legacy duplicate handles on upgrade to v2', () => {
    expect(() => runMigrations(sqliteDb.connection)).not.toThrow();

    // Simulate a legacy v1 database containing duplicate handles before migration v2
    const legacyRaw = new Database(':memory:');
    legacyRaw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1700000000);
      CREATE TABLE tracked_accounts (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        website_url TEXT,
        avatar_url TEXT,
        banner_url TEXT,
        include_replies INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        availability TEXT NOT NULL DEFAULT 'available',
        unavailable_reason TEXT,
        consecutive_misses INTEGER NOT NULL DEFAULT 0,
        baseline_at INTEGER NOT NULL,
        last_tweet_seen_at INTEGER,
        last_profile_checked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_tracked_accounts_handle ON tracked_accounts(handle COLLATE NOCASE);
      INSERT INTO tracked_accounts (user_id, handle, enabled, baseline_at, created_at, updated_at)
        VALUES ('222', 'dup_handle', 0, 100, 100, 100);
      INSERT INTO tracked_accounts (user_id, handle, enabled, baseline_at, created_at, updated_at)
        VALUES ('111', 'DUP_HANDLE', 1, 200, 200, 200);
    `);

    expect(() => runMigrations(legacyRaw, 1700001000)).not.toThrow();

    const repo = new SqliteAccountRepository(legacyRaw);
    expect(repo.findByUserId('111')?.handle.toLowerCase()).toBe('dup_handle');
    expect(repo.findByUserId('222')?.handle).toBe('dup_handle#222');

    // Verify true SQLite UNIQUE index is now enforced at the schema level
    expect(() =>
      legacyRaw
        .prepare(
          `INSERT INTO tracked_accounts (user_id, handle, baseline_at, created_at, updated_at)
           VALUES ('333', 'dup_handle', 300, 300, 300)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    legacyRaw.close();
  });

  it('auto-creates nested parent directories on fresh boot and configures WAL + busy_timeout', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x-monitor-db-test-'));
    const nestedDbPath = path.join(tmpRoot, 'deep', 'nested', 'dir', 'monitor.db');

    try {
      const fileDb = new SqliteDatabase(nestedDbPath);
      expect(fs.existsSync(nestedDbPath)).toBe(true);

      const journalMode = fileDb.connection.pragma('journal_mode', {
        simple: true,
      });
      const busyTimeout = fileDb.connection.pragma('busy_timeout', {
        simple: true,
      });
      const foreignKeys = fileDb.connection.pragma('foreign_keys', {
        simple: true,
      });

      expect(String(journalMode).toLowerCase()).toBe('wal');
      expect(busyTimeout).toBe(5000);
      expect(foreignKeys).toBe(1);

      expect(() => fileDb.optimize()).not.toThrow();
      fileDb.close();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('uses idx_seen_tweets_seen_at index (no full table scan) when pruning seen_tweets', () => {
    const planRows = sqliteDb.connection
      .prepare<[number], { detail: string }>(
        'EXPLAIN QUERY PLAN DELETE FROM seen_tweets WHERE seen_at_unix < ?',
      )
      .all(1_700_000_000);

    const planText = planRows.map((r) => r.detail).join(' ');
    expect(planText).toContain('idx_seen_tweets_seen_at');
    expect(planText).not.toContain('SCAN seen_tweets');
  });

  it('handles @handle rename collisions and simultaneous swaps without SQLITE_CONSTRAINT_UNIQUE', () => {
    const repo = new SqliteAccountRepository(sqliteDb.connection);

    // 1) Stale/paused account id=222 holds @foo; active account id=111 holds @bar
    repo.upsertNewAccount({
      userId: '222',
      handle: 'foo',
      displayName: 'Old Foo',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1000,
      nowUnix: 1000,
    });
    repo.toggleEnabled('222', 1010);

    repo.upsertNewAccount({
      userId: '111',
      handle: 'bar',
      displayName: 'Active Bar',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1000,
      nowUnix: 1000,
    });

    // Account 111 renames to @foo (case-insensitive collision with 222!)
    expect(() =>
      repo.updateProfileSnapshot({
        userId: '111',
        handle: 'FOO',
        displayName: 'New Foo Owner',
        bio: 'Claimed @foo',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
        consecutiveMisses: 0,
        checkedAtUnix: 1050,
        updatedAtUnix: 1050,
      }),
    ).not.toThrow();

    expect(repo.findByHandle('foo')?.userId).toBe('111');
    expect(repo.findByUserId('222')?.handle).toBe('foo#222');

    // 2) Two accounts swap handles (@alpha <-> @beta)
    repo.upsertNewAccount({
      userId: '301',
      handle: 'alpha',
      displayName: 'A',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 2000,
      nowUnix: 2000,
    });
    repo.upsertNewAccount({
      userId: '302',
      handle: 'beta',
      displayName: 'B',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 2000,
      nowUnix: 2000,
    });

    repo.updateProfileSnapshot({
      userId: '301',
      handle: 'beta',
      displayName: 'A now Beta',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      consecutiveMisses: 0,
      checkedAtUnix: 2100,
      updatedAtUnix: 2100,
    });
    repo.updateProfileSnapshot({
      userId: '302',
      handle: 'alpha',
      displayName: 'B now Alpha',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      consecutiveMisses: 0,
      checkedAtUnix: 2100,
      updatedAtUnix: 2100,
    });

    expect(repo.findByUserId('301')?.handle).toBe('beta');
    expect(repo.findByUserId('302')?.handle).toBe('alpha');
  });

  it('supports full account lifecycle, pagination, toggles, and consecutive misses', () => {
    const repo = new SqliteAccountRepository(sqliteDb.connection);

    const acc1 = repo.upsertNewAccount({
      userId: '1001',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: 'Bio 1',
      websiteUrl: 'https://azuki.com',
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1700000000,
      nowUnix: 1700000000,
    });

    repo.upsertNewAccount({
      userId: '1002',
      handle: 'boredapeyc',
      displayName: 'BAYC',
      bio: 'Bio 2',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1700000000,
      nowUnix: 1700000000,
    });

    expect(acc1.handle).toBe('azuki');
    expect(repo.findByHandle('AZUKI')?.userId).toBe('1001');
    expect(repo.getCounts()).toEqual({
      total: 2,
      active: 2,
      paused: 0,
      unavailable: 0,
    });

    const toggledReplies = repo.toggleIncludeReplies('1001', 1700000050);
    expect(toggledReplies?.includeReplies).toBe(true);

    const paused = repo.toggleEnabled('1002', 1700000060);
    expect(paused?.enabled).toBe(false);
    expect(repo.listActive().map((a) => a.userId)).toEqual(['1001']);

    repo.recordConsecutiveMiss('1001', 2, true, 'Missing', 1700000100);
    expect(repo.findByUserId('1001')?.availability).toBe('unavailable');

    const page1 = repo.listPaginated(1, 1);
    expect(page1.total).toBe(2);
    expect(page1.totalPages).toBe(2);
    expect(page1.items).toHaveLength(1);

    expect(repo.deleteByHandle('@azuki')?.userId).toBe('1001');
    expect(repo.findByUserId('1001')).toBeNull();
  });

  it('filters unseen tweet IDs across >500 chunk boundaries and prunes expired seen_tweets', () => {
    const seenRepo = new SqliteSeenTweetRepository(sqliteDb.connection);

    const records = Array.from({ length: 620 }, (_, idx) => ({
      tweetId: `tweet_${idx}`,
      authorId: '1001',
      createdAtUnix: 1700000000 + idx,
      seenAtUnix: idx < 200 ? 1700000100 : 1700900000,
    }));

    seenRepo.markSeenBatch(records);
    expect(seenRepo.count()).toBe(620);

    const checkList = [
      ...records.slice(0, 610).map((r) => r.tweetId),
      'brand_new_1',
      'brand_new_2',
    ];
    const unseen = seenRepo.filterUnseenIds(checkList);
    expect(Array.from(unseen).sort()).toEqual(['brand_new_1', 'brand_new_2']);

    const pruned = seenRepo.pruneOlderThan(1700500000);
    expect(pruned).toBe(200);
    expect(seenRepo.count()).toBe(420);
  });

  it('persists trigger keywords and sync_state key-value entries', () => {
    const kwRepo = new SqliteKeywordRepository(sqliteDb.connection);
    const syncRepo = new SqliteSyncStateRepository(sqliteDb.connection);

    expect(kwRepo.addMany(['Mint', 'WL', 'mint'], 1700000000)).toBe(2);
    expect(kwRepo.listAll()).toEqual(['mint', 'wl']);
    expect(kwRepo.remove('WL')).toBe(true);
    expect(kwRepo.listAll()).toEqual(['mint']);

    syncRepo.set('last_tweet_poll_unix', '1700001234', 1700001234);
    expect(syncRepo.get('last_tweet_poll_unix')).toBe('1700001234');
    syncRepo.set('last_tweet_poll_unix', '1700005678', 1700005678);
    expect(syncRepo.get('last_tweet_poll_unix')).toBe('1700005678');
  });

  it('chunks getUsersByIds (>100 IDs), preserves 64-bit Snowflake id_str, and bounds MockTwitterProvider memory', async () => {
    const fakeClock: Clock = {
      nowMs: () => 1_700_000_000_000,
      nowUnix: () => 1_700_000_000,
      sleep: async () => {},
    };
    const silentLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => silentLogger,
    };

    const batchSizes: number[] = [];
    const httpClient = new RateLimitedHttpClient(fakeClock, silentLogger, {
      minIntervalMs: 0,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchFn: async (input) => {
        const u = new URL(String(input));
        const ids = (u.searchParams.get('userIds') ?? '').split(',').filter(Boolean);
        batchSizes.push(ids.length);
        return new Response(
          JSON.stringify({
            users: ids.map((id) => ({
              id_str: id,
              userName: `user_${id}`,
              name: `User ${id}`,
            })),
          }),
          { status: 200 },
        );
      },
    });

    const provider = new TwitterApiIoProvider(httpClient, fakeClock, {
      baseUrl: 'https://api.twitterapi.io',
      apiKey: 'test_key',
    });

    const ids235 = Array.from({ length: 235 }, (_, i) => String(10_000 + i));
    const profiles = await provider.getUsersByIds(ids235);
    expect(batchSizes).toEqual([100, 100, 35]);
    expect(profiles).toHaveLength(235);

    // 64-bit Snowflake precision check + malicious URL sanitization in PayloadNormalizer
    // eslint-disable-next-line no-loss-of-precision
    const impreciseFloat = Number('1900000000000000123');
    const normalizedTweet = PayloadNormalizer.normalizeTweetObject(
      {
        id: impreciseFloat,
        id_str: '1900000000000000123',
        text: 'Mint live',
        url: 'javascript:alert(1)',
        author: {
          id: impreciseFloat,
          id_str: '18446744073709551615',
          userName: 'azuki',
          name: 'Azuki',
        },
      },
      1_700_000_000,
    );
    expect(normalizedTweet?.id).toBe('1900000000000000123');
    expect(normalizedTweet?.authorId).toBe('18446744073709551615');
    expect(normalizedTweet?.url).toBe(
      'https://x.com/azuki/status/1900000000000000123',
    );

    // MockTwitterProvider bounded Map eviction check
    const mock = new MockTwitterProvider(fakeClock, { autoEvents: true });
    for (let i = 0; i < 650; i += 1) {
      mock.pushTweet({
        id: `t_${i}`,
        authorId: '100001',
        authorHandle: 'boredapeyc',
        authorDisplayName: 'BAYC',
        text: 'gm',
        createdAtUnix: 1_700_000_000 + i,
        url: `https://x.com/boredapeyc/status/t_${i}`,
        isReply: false,
        inReplyToTweetId: null,
        inReplyToHandle: null,
        retweetedTweet: null,
        quotedTweet: null,
        expandedUrls: [],
      });
    }
    const page = await mock.searchRecentTweets({ query: '(from:boredapeyc) since_time:0' });
    expect(page.tweets.length).toBeLessThanOrEqual(500);
  });
});
