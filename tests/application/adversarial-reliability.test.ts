import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlertDeliveryError,
  type AlertNotifier,
} from '../../src/application/ports/alert-notifier.js';
import { SystemClock, type Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import type {
  RequestPriority,
  TweetSearchPage,
  TwitterProvider,
  TwitterProviderHealthSnapshot,
} from '../../src/application/ports/twitter-provider.js';
import { AccountManagementService } from '../../src/application/services/account-management-service.js';
import { KeywordManagementService } from '../../src/application/services/keyword-management-service.js';
import { MaintenanceService } from '../../src/application/services/maintenance-service.js';
import { MonitorCoordinator } from '../../src/application/services/monitor-coordinator.js';
import { ProfileMonitorService } from '../../src/application/services/profile-monitor-service.js';
import {
  LAST_TWEET_POLL_UNIX_KEY,
  TweetMonitorService,
} from '../../src/application/services/tweet-monitor-service.js';
import type { TwitterUserProfile } from '../../src/domain/entities/account.js';
import type {
  ProfileAlertEvent,
  SystemAlertEvent,
  TweetAlertEvent,
} from '../../src/domain/entities/alerts.js';
import type { NormalizedTweet } from '../../src/domain/entities/tweet.js';
import { SearchQueryBuilder } from '../../src/domain/services/search-query-builder.js';
import { SqliteAccountRepository } from '../../src/infrastructure/persistence/sqlite-account-repository.js';
import { SqliteDatabase } from '../../src/infrastructure/persistence/sqlite-database.js';
import { SqliteKeywordRepository } from '../../src/infrastructure/persistence/sqlite-keyword-repository.js';
import { SqliteSeenTweetRepository } from '../../src/infrastructure/persistence/sqlite-seen-tweet-repository.js';
import { SqliteSyncStateRepository } from '../../src/infrastructure/persistence/sqlite-sync-state-repository.js';
import { TwitterProviderHttpError } from '../../src/infrastructure/twitter/errors.js';
import { RateLimitedHttpClient } from '../../src/infrastructure/twitter/rate-limited-http-client.js';
import { TwitterApiIoProvider } from '../../src/infrastructure/twitter/twitter-api-io-provider.js';

class ManualClock implements Clock {
  public currentSec = 1_762_610_000;

  public nowMs(): number {
    return this.currentSec * 1000;
  }

  public nowUnix(): number {
    return this.currentSec;
  }

  public async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    this.currentSec += Math.ceil(Math.max(0, ms) / 1000);
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function buildTweet(
  id: string,
  authorId: string,
  authorHandle: string,
  text: string,
  createdAtUnix: number,
): NormalizedTweet {
  return {
    id,
    authorId,
    authorHandle,
    authorDisplayName: authorHandle,
    text,
    createdAtUnix,
    url: `https://x.com/${authorHandle}/status/${id}`,
    isReply: false,
    inReplyToTweetId: null,
    inReplyToHandle: null,
    retweetedTweet: null,
    quotedTweet: null,
    expandedUrls: [],
  };
}

describe('Adversarial & Multi-Week Production Reliability Scenarios', () => {
  let db: SqliteDatabase;
  let clock: ManualClock;
  let accountRepo: SqliteAccountRepository;
  let seenTweetRepo: SqliteSeenTweetRepository;
  let keywordRepo: SqliteKeywordRepository;
  let syncStateRepo: SqliteSyncStateRepository;

  beforeEach(() => {
    db = new SqliteDatabase(':memory:');
    clock = new ManualClock();
    accountRepo = new SqliteAccountRepository(db.connection);
    seenTweetRepo = new SqliteSeenTweetRepository(db.connection);
    keywordRepo = new SqliteKeywordRepository(db.connection);
    syncStateRepo = new SqliteSyncStateRepository(db.connection);

    const kwService = new KeywordManagementService(
      keywordRepo,
      syncStateRepo,
      clock,
      silentLogger,
    );
    kwService.ensureDefaultsSeeded();
  });

  afterEach(() => {
    db.close();
  });

  it('enforces Seen-after-Send: transient Telegram errors retry without losing tweets, while permanent 4xx errors mark seen without blocking', async () => {
    accountRepo.upsertNewAccount({
      userId: '101',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: clock.currentSec,
      nowUnix: clock.currentSec,
    });
    syncStateRepo.set(LAST_TWEET_POLL_UNIX_KEY, String(clock.currentSec), clock.currentSec);

    const tweets: NormalizedTweet[] = [
      buildTweet(
        'mint_retryable',
        '101',
        'azuki',
        'Mint LIVE! 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
        clock.currentSec + 10,
      ),
    ];

    const stubProvider: TwitterProvider = {
      mode: 'MOCK',
      getUserByHandle: async () => null,
      getUsersByIds: async () => [],
      searchRecentTweets: async () => ({
        tweets,
        hasNextPage: false,
        nextCursor: null,
      }),
      getHealthSnapshot: (): TwitterProviderHealthSnapshot => ({
        mode: 'MOCK',
        totalRequests: 1,
        rateLimitHits: 0,
        lastError: null,
        lastErrorAtUnix: null,
        lastRequestAtUnix: clock.currentSec,
        queuedHigh: 0,
        queuedNormal: 0,
      }),
    };

    let mode: 'TRANSIENT_FAIL' | 'PERMANENT_FAIL' | 'OK' = 'TRANSIENT_FAIL';
    const deliveredIds: string[] = [];

    const flakyNotifier: AlertNotifier = {
      sendTweetAlert: async (ev: TweetAlertEvent) => {
        if (mode === 'TRANSIENT_FAIL') {
          throw new AlertDeliveryError('Telegram 502 Bad Gateway', {
            retryable: true,
          });
        }
        if (mode === 'PERMANENT_FAIL') {
          throw new AlertDeliveryError('400 Bad Request: chat not found', {
            retryable: false,
          });
        }
        deliveredIds.push(ev.tweet.id);
      },
      sendProfileAlert: async () => {},
      sendSystemAlert: async () => {},
    };

    const tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      stubProvider,
      flakyNotifier,
      clock,
      silentLogger,
      {
        overlapBufferSec: 90,
        coldStartLookbackSec: 300,
        maxLookbackSec: 1800,
        maxHandlesPerBatch: 20,
        maxQueryLength: 450,
        maxPagesPerBatch: 3,
      },
    );

    // Cycle 1: Telegram fails transiently -> tweet MUST remain unseen & last_tweet_poll_unix unchanged!
    const prevPollUnix = syncStateRepo.get(LAST_TWEET_POLL_UNIX_KEY);
    clock.currentSec += 30;
    await expect(tweetMonitor.runCycle()).rejects.toThrow(/502 Bad Gateway/);
    expect(seenTweetRepo.filterUnseenIds(['mint_retryable']).has('mint_retryable')).toBe(
      true,
    );
    expect(syncStateRepo.get(LAST_TWEET_POLL_UNIX_KEY)).toBe(prevPollUnix);

    // Cycle 2: Telegram recovers -> tweet is delivered ONCE and now marked seen!
    mode = 'OK';
    clock.currentSec += 30;
    const summary2 = await tweetMonitor.runCycle();
    expect(summary2.alertsSent).toBe(1);
    expect(deliveredIds).toEqual(['mint_retryable']);
    expect(seenTweetRepo.filterUnseenIds(['mint_retryable']).size).toBe(0);

    // Cycle 3: New tweet hits non-retryable 400 error -> marked seen so pipeline doesn't wedge forever
    tweets.push(
      buildTweet(
        'poison_400_tweet',
        '101',
        'azuki',
        'Another update',
        clock.currentSec + 5,
      ),
    );
    mode = 'PERMANENT_FAIL';
    clock.currentSec += 30;
    const summary3 = await tweetMonitor.runCycle();
    expect(summary3.alertsSent).toBe(0);
    expect(seenTweetRepo.filterUnseenIds(['poison_400_tweet']).size).toBe(0);
  });

  it('recovers from partial batch poll failures (>20 accounts) without losing failed chunk tweets or duplicating healthy chunk alerts', async () => {
    const initialUnix = clock.currentSec;
    syncStateRepo.set(LAST_TWEET_POLL_UNIX_KEY, String(initialUnix), initialUnix);

    // Seed 25 active accounts -> Batch 1 (20 handles: acct_01..acct_20), Batch 2 (5 handles: acct_21..acct_25)
    for (let i = 1; i <= 25; i += 1) {
      const padded = String(i).padStart(2, '0');
      accountRepo.upsertNewAccount({
        userId: String(1000 + i),
        handle: `acct_${padded}`,
        displayName: `Account ${padded}`,
        bio: '',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
        baselineAt: initialUnix,
        nowUnix: initialUnix,
      });
    }

    let failChunk2 = true;
    const delivered: string[] = [];

    const chunkedProvider: TwitterProvider = {
      mode: 'LIVE',
      getUserByHandle: async () => null,
      getUsersByIds: async () => [],
      searchRecentTweets: async ({ query }) => {
        if (query.includes('from:acct_25')) {
          if (failChunk2) {
            throw new TwitterProviderHttpError('Upstream 503', 503, 'Unavailable');
          }
          return {
            tweets: [
              buildTweet(
                'chunk2_mint',
                '1025',
                'acct_25',
                'Chunk 2 Mint LIVE!',
                initialUnix + 15,
              ),
            ],
            hasNextPage: false,
            nextCursor: null,
          };
        }

        return {
          tweets: [
            buildTweet(
              'chunk1_mint',
              '1001',
              'acct_01',
              'Chunk 1 Mint LIVE!',
              initialUnix + 10,
            ),
          ],
          hasNextPage: false,
          nextCursor: null,
        };
      },
      getHealthSnapshot: (): TwitterProviderHealthSnapshot => ({
        mode: 'LIVE',
        totalRequests: 2,
        rateLimitHits: 0,
        lastError: null,
        lastErrorAtUnix: null,
        lastRequestAtUnix: clock.currentSec,
        queuedHigh: 0,
        queuedNormal: 0,
      }),
    };

    const notifier: AlertNotifier = {
      sendTweetAlert: async (ev) => {
        delivered.push(ev.tweet.id);
      },
      sendProfileAlert: async () => {},
      sendSystemAlert: async () => {},
    };

    const tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      chunkedProvider,
      notifier,
      clock,
      silentLogger,
      {
        overlapBufferSec: 90,
        coldStartLookbackSec: 300,
        maxLookbackSec: 1800,
        maxHandlesPerBatch: 20,
        maxQueryLength: 450,
        maxPagesPerBatch: 3,
      },
    );

    // Cycle 1: Chunk 1 succeeds & delivers alert immediately, Chunk 2 fails with 503 -> last_tweet_poll_unix NOT advanced!
    clock.currentSec += 60;
    await expect(tweetMonitor.runCycle()).rejects.toThrow(/Upstream 503/);
    expect(delivered).toEqual(['chunk1_mint']);
    expect(syncStateRepo.get(LAST_TWEET_POLL_UNIX_KEY)).toBe(String(initialUnix));

    // Cycle 2: Chunk 2 recovers -> Chunk 2's tweet from initialUnix+15 IS delivered, Chunk 1 sends 0 duplicates!
    failChunk2 = false;
    clock.currentSec += 60;
    const recoverySummary = await tweetMonitor.runCycle();
    expect(recoverySummary.alertsSent).toBe(1);
    expect(delivered).toEqual(['chunk1_mint', 'chunk2_mint']);
    expect(syncStateRepo.get(LAST_TWEET_POLL_UNIX_KEY)).toBe(
      String(clock.currentSec),
    );
  });

  it('terminates pagination immediately when upstream returns repeated cursors or duplicate-only pages', async () => {
    accountRepo.upsertNewAccount({
      userId: '101',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: clock.currentSec,
      nowUnix: clock.currentSec,
    });

    let searchCalls = 0;
    const loopingCursorProvider: TwitterProvider = {
      mode: 'LIVE',
      getUserByHandle: async () => null,
      getUsersByIds: async () => [],
      searchRecentTweets: async ({ cursor }): Promise<TweetSearchPage> => {
        searchCalls += 1;
        // Cycle: null -> cur_A -> cur_B -> cur_A (infinite 2-step cursor loop!)
        const nextCursor = cursor === 'cur_A' ? 'cur_B' : 'cur_A';
        return {
          tweets: [
            buildTweet(
              `t_${searchCalls}`,
              '101',
              'azuki',
              `Post ${searchCalls}`,
              clock.currentSec + searchCalls,
            ),
          ],
          hasNextPage: true,
          nextCursor,
        };
      },
      getHealthSnapshot: (): TwitterProviderHealthSnapshot => ({
        mode: 'LIVE',
        totalRequests: searchCalls,
        rateLimitHits: 0,
        lastError: null,
        lastErrorAtUnix: null,
        lastRequestAtUnix: clock.currentSec,
        queuedHigh: 0,
        queuedNormal: 0,
      }),
    };

    const alerts: string[] = [];
    const tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      loopingCursorProvider,
      {
        sendTweetAlert: async (ev) => {
          alerts.push(ev.tweet.id);
        },
        sendProfileAlert: async () => {},
        sendSystemAlert: async () => {},
      },
      clock,
      silentLogger,
      {
        overlapBufferSec: 90,
        coldStartLookbackSec: 300,
        maxLookbackSec: 1800,
        maxHandlesPerBatch: 20,
        maxQueryLength: 450,
        maxPagesPerBatch: 15, // High cap, must stop at 3 calls (null, cur_A, cur_B -> sees cur_A again!)
      },
    );

    const summary = await tweetMonitor.runCycle();
    expect(searchCalls).toBe(3);
    expect(summary.alertsSent).toBe(3);
  });

  it('caps post-downtime tweet floods (maxAlertsPerCycle) while prioritizing HIGH NFT contract signals', async () => {
    const baseTime = clock.currentSec;
    accountRepo.upsertNewAccount({
      userId: '101',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: baseTime,
      nowUnix: baseTime,
    });

    // 12 tweets total: 2 HIGH-priority mint tweets early in the burst + 10 ordinary GM tweets after
    const burstTweets: NormalizedTweet[] = [
      buildTweet(
        'high_mint_1',
        '101',
        'azuki',
        'MINT LIVE! 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
        baseTime + 1,
      ),
      buildTweet(
        'high_mint_2',
        '101',
        'azuki',
        'Allowlist claim open on https://claim.manifold.xyz/azuki',
        baseTime + 2,
      ),
      ...Array.from({ length: 10 }, (_, idx) =>
        buildTweet(
          `normal_gm_${idx + 1}`,
          '101',
          'azuki',
          `GM coffee post #${idx + 1}`,
          baseTime + 10 + idx,
        ),
      ),
    ];

    const sentIds: string[] = [];
    const tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      {
        mode: 'MOCK',
        getUserByHandle: async () => null,
        getUsersByIds: async () => [],
        searchRecentTweets: async () => ({
          tweets: burstTweets,
          hasNextPage: false,
          nextCursor: null,
        }),
        getHealthSnapshot: () => ({
          mode: 'MOCK',
          totalRequests: 1,
          rateLimitHits: 0,
          lastError: null,
          lastErrorAtUnix: null,
          lastRequestAtUnix: clock.currentSec,
          queuedHigh: 0,
          queuedNormal: 0,
        }),
      },
      {
        sendTweetAlert: async (ev) => {
          sentIds.push(ev.tweet.id);
        },
        sendProfileAlert: async () => {},
        sendSystemAlert: async () => {},
      },
      clock,
      silentLogger,
      {
        overlapBufferSec: 90,
        coldStartLookbackSec: 300,
        maxLookbackSec: 1800,
        maxHandlesPerBatch: 20,
        maxQueryLength: 450,
        maxPagesPerBatch: 3,
        maxAlertsPerCycle: 5,
      },
    );

    clock.currentSec += 60;
    const c1 = await tweetMonitor.runCycle();
    expect(c1.alertsSent).toBe(5);
    // Both HIGH-priority NFT signals MUST be preserved despite being oldest in the burst!
    expect(sentIds).toContain('high_mint_1');
    expect(sentIds).toContain('high_mint_2');
    expect(sentIds).toEqual([
      'high_mint_1',
      'high_mint_2',
      'normal_gm_8',
      'normal_gm_9',
      'normal_gm_10',
    ]);

    // Next cycle sends 0 alerts because suppressed overflow tweets were marked seen
    clock.currentSec += 30;
    const c2 = await tweetMonitor.runCycle();
    expect(c2.alertsSent).toBe(0);
  });

  it('handles @handle rename collisions with paused accounts, /add re-claim, and 120-account batch chunking in ProfileMonitorService', async () => {
    // Seed paused account id=222 holding @alpha, and active account id=111 holding @beta
    accountRepo.upsertNewAccount({
      userId: '222',
      handle: 'alpha',
      displayName: 'Old Alpha',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1000,
      nowUnix: 1000,
    });
    accountRepo.toggleEnabled('222', 1005);

    accountRepo.upsertNewAccount({
      userId: '111',
      handle: 'beta',
      displayName: 'Active Project',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: 1000,
      nowUnix: 1000,
    });

    // Also seed 119 more active accounts (total 120 active accounts!) to verify batch chunking
    for (let i = 1; i <= 119; i += 1) {
      accountRepo.upsertNewAccount({
        userId: String(5000 + i),
        handle: `extra_${i}`,
        displayName: `Extra ${i}`,
        bio: '',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
        baselineAt: 1000,
        nowUnix: 1000,
      });
    }

    const queriedChunkLengths: number[] = [];
    const profileAlerts: ProfileAlertEvent[] = [];

    const provider: TwitterProvider = {
      mode: 'LIVE',
      getUserByHandle: async (handle: string): Promise<TwitterUserProfile | null> => ({
        userId: '333',
        handle: handle.toLowerCase(),
        displayName: 'Brand New Owner',
        bio: 'New founder',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
      }),
      getUsersByIds: async (
        ids: readonly string[],
        _opts?: { priority?: RequestPriority; signal?: AbortSignal },
      ) => {
        queriedChunkLengths.push(ids.length);
        return ids.map((id) => ({
          userId: id,
          // Account 111 renames from @beta -> @alpha (colliding with paused id=222!)
          handle: id === '111' ? 'alpha' : `extra_${Number(id) - 5000}`,
          displayName: id === '111' ? 'Active Project' : `Extra ${Number(id) - 5000}`,
          bio: '',
          websiteUrl: null,
          avatarUrl: null,
          bannerUrl: null,
          availability: 'available',
          unavailableReason: null,
        }));
      },
      searchRecentTweets: async () => ({
        tweets: [],
        hasNextPage: false,
        nextCursor: null,
      }),
      getHealthSnapshot: () => ({
        mode: 'LIVE',
        totalRequests: queriedChunkLengths.length,
        rateLimitHits: 0,
        lastError: null,
        lastErrorAtUnix: null,
        lastRequestAtUnix: clock.currentSec,
        queuedHigh: 0,
        queuedNormal: 0,
      }),
    };

    const profileMonitor = new ProfileMonitorService(
      accountRepo,
      keywordRepo,
      syncStateRepo,
      provider,
      {
        sendTweetAlert: async () => {},
        sendProfileAlert: async (ev) => {
          profileAlerts.push(ev);
        },
        sendSystemAlert: async () => {},
      },
      clock,
      silentLogger,
      { maxUsersPerBatch: 50, consecutiveMissThreshold: 2 },
    );

    const summary = await profileMonitor.runCycle();
    expect(queriedChunkLengths).toEqual([50, 50, 20]);
    expect(summary.batchesQueried).toBe(3);
    expect(profileAlerts).toHaveLength(1);
    expect(profileAlerts[0]?.diff.changes).toEqual([
      { field: 'handle', before: '@beta', after: '@alpha' },
    ]);

    expect(accountRepo.findByUserId('111')?.handle).toBe('alpha');
    expect(accountRepo.findByUserId('222')?.handle).toBe('alpha#222');

    // Displaced handle alpha#222 is safely excluded from X search queries even if 222 is unpaused
    accountRepo.toggleEnabled('222', 1100);
    const batches = SearchQueryBuilder.buildBatches(
      ['alpha', 'alpha#222'],
      1700000000,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.handles).toEqual(['alpha']);

    // Also test /add @paused_handle when a brand-new userId (333) now owns that handle on X
    accountRepo.upsertNewAccount({
      userId: '888',
      handle: 'reclaimed_nft',
      displayName: 'Stale',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'unavailable',
      unavailableReason: 'Suspended',
      baselineAt: 1000,
      nowUnix: 1000,
    });
    const accountSvc = new AccountManagementService(
      accountRepo,
      provider,
      clock,
      silentLogger,
    );
    const reclaimRes = await accountSvc.addAccount('@reclaimed_nft');
    expect(reclaimRes.status).toBe('ADDED');
    if (reclaimRes.status === 'ADDED') {
      expect(reclaimRes.account.userId).toBe('333');
    }
    expect(accountRepo.findByUserId('888')?.handle).toBe('reclaimed_nft#888');
  });

  it('survives 402 credit exhaustion without crashing MonitorCoordinator and aborts immediately on SIGTERM during backoff', async () => {
    const realClock = new SystemClock();
    accountRepo.upsertNewAccount({
      userId: '101',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'available',
      unavailableReason: null,
      baselineAt: realClock.nowUnix() - 10,
      nowUnix: realClock.nowUnix(),
    });

    const systemAlerts: SystemAlertEvent[] = [];
    const tweetAlerts: TweetAlertEvent[] = [];
    let apiMode: 'QUOTA_402' | 'BACKOFF_429' | 'HEALTHY' = 'QUOTA_402';

    const httpClient = new RateLimitedHttpClient(realClock, silentLogger, {
      minIntervalMs: 0,
      timeoutMs: 5000,
      maxRetries: 2,
      baseBackoffMs: 30_000,
      maxBackoffMs: 60_000,
      jitterMaxMs: 0,
      fetchFn: async () => {
        if (apiMode === 'QUOTA_402') {
          return new Response('{"msg":"Out of credits"}', { status: 402 });
        }
        if (apiMode === 'BACKOFF_429') {
          return new Response('Too many requests', {
            status: 429,
            headers: { 'Retry-After': '45' },
          });
        }
        return new Response(
          JSON.stringify({
            tweets: [
              {
                id_str: '9001',
                text: 'Mint LIVE after credit top-up!',
                createdAt: new Date().toUTCString(),
                author: { id_str: '101', userName: 'azuki', name: 'Azuki' },
              },
            ],
            has_next_page: false,
          }),
          { status: 200 },
        );
      },
      onAuthOrQuotaError: async (info) => {
        systemAlerts.push({
          level: 'ERROR',
          title: `HTTP ${info.statusCode}`,
          message: info.responseBody,
          statusCode: info.statusCode,
          occurredAtUnix: info.occurredAtUnix,
        });
      },
    });

    const liveProvider = new TwitterApiIoProvider(httpClient, realClock, {
      baseUrl: 'https://api.twitterapi.io',
      apiKey: 'live_key',
    });

    const notifier: AlertNotifier = {
      sendTweetAlert: async (ev) => {
        tweetAlerts.push(ev);
      },
      sendProfileAlert: async () => {},
      sendSystemAlert: async (ev) => {
        systemAlerts.push(ev);
      },
    };

    const tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      liveProvider,
      notifier,
      realClock,
      silentLogger,
      {
        overlapBufferSec: 90,
        coldStartLookbackSec: 300,
        maxLookbackSec: 1800,
        maxHandlesPerBatch: 20,
        maxQueryLength: 450,
        maxPagesPerBatch: 2,
      },
    );
    const profileMonitor = new ProfileMonitorService(
      accountRepo,
      keywordRepo,
      syncStateRepo,
      liveProvider,
      notifier,
      realClock,
      silentLogger,
      { maxUsersPerBatch: 50 },
    );
    const maint = new MaintenanceService(
      seenTweetRepo,
      syncStateRepo,
      db,
      realClock,
      silentLogger,
      7,
    );
    const coordinator = new MonitorCoordinator(
      tweetMonitor,
      profileMonitor,
      maint,
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      liveProvider,
      realClock,
      silentLogger,
      {
        tweetPollIntervalSec: 60,
        profilePollIntervalSec: 180,
        maintenanceIntervalSec: 3600,
      },
    );

    // 1) 402 error recorded in status without crashing; throttled alert emitted once
    await expect(coordinator.runTweetCycleSingleFlight()).rejects.toThrow(/402/);
    expect(systemAlerts).toHaveLength(1);
    expect(coordinator.getStatusSnapshot().lastTweetError).toContain('402');

    // 2) Credits topped up -> recovers cleanly and clears lastTweetError
    apiMode = 'HEALTHY';
    const recovered = await coordinator.runTweetCycleSingleFlight();
    expect(recovered.alertsSent).toBe(1);
    expect(tweetAlerts).toHaveLength(1);
    expect(coordinator.getStatusSnapshot().lastTweetError).toBeNull();

    // 3) Start background loops while API hits 45s 429 Retry-After backoff -> SIGTERM stop() resolves in <200ms!
    apiMode = 'BACKOFF_429';
    const rootSig = new AbortController();
    coordinator.start(rootSig.signal);
    await new Promise((r) => setTimeout(r, 20));

    const stopStartMs = Date.now();
    rootSig.abort();
    await coordinator.stop();
    expect(Date.now() - stopStartMs).toBeLessThan(400);
  });
});
