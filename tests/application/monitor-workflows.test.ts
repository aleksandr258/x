import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertNotifier } from '../../src/application/ports/alert-notifier.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import { AccountManagementService } from '../../src/application/services/account-management-service.js';
import { KeywordManagementService } from '../../src/application/services/keyword-management-service.js';
import { MaintenanceService } from '../../src/application/services/maintenance-service.js';
import { MonitorCoordinator } from '../../src/application/services/monitor-coordinator.js';
import { ProfileMonitorService } from '../../src/application/services/profile-monitor-service.js';
import { TestAlertService } from '../../src/application/services/test-alert-service.js';
import { TweetMonitorService } from '../../src/application/services/tweet-monitor-service.js';
import { createApplication } from '../../src/bootstrap.js';
import { loadAppConfig } from '../../src/config/env.js';
import type {
  ProfileAlertEvent,
  SystemAlertEvent,
  TweetAlertEvent,
} from '../../src/domain/entities/alerts.js';
import { SqliteAccountRepository } from '../../src/infrastructure/persistence/sqlite-account-repository.js';
import { SqliteDatabase } from '../../src/infrastructure/persistence/sqlite-database.js';
import { SqliteKeywordRepository } from '../../src/infrastructure/persistence/sqlite-keyword-repository.js';
import { SqliteSeenTweetRepository } from '../../src/infrastructure/persistence/sqlite-seen-tweet-repository.js';
import { SqliteSyncStateRepository } from '../../src/infrastructure/persistence/sqlite-sync-state-repository.js';
import { MockTwitterProvider } from '../../src/infrastructure/twitter/mock-twitter-provider.js';

class ManualClock implements Clock {
  public currentSec = 1_762_610_000;

  public nowMs(): number {
    return this.currentSec * 1000;
  }

  public nowUnix(): number {
    return this.currentSec;
  }

  public async sleep(_ms: number): Promise<void> {
    // Instantaneous in tests
  }
}

class RecordingAlertNotifier implements AlertNotifier {
  public readonly tweetAlerts: TweetAlertEvent[] = [];
  public readonly profileAlerts: ProfileAlertEvent[] = [];
  public readonly systemAlerts: SystemAlertEvent[] = [];

  public async sendTweetAlert(event: TweetAlertEvent): Promise<void> {
    this.tweetAlerts.push(event);
  }

  public async sendProfileAlert(event: ProfileAlertEvent): Promise<void> {
    this.profileAlerts.push(event);
  }

  public async sendSystemAlert(event: SystemAlertEvent): Promise<void> {
    this.systemAlerts.push(event);
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe('End-to-End Application Monitor Workflows', () => {
  let db: SqliteDatabase;
  let clock: ManualClock;
  let notifier: RecordingAlertNotifier;
  let mockProvider: MockTwitterProvider;
  let accountRepo: SqliteAccountRepository;
  let seenTweetRepo: SqliteSeenTweetRepository;
  let keywordRepo: SqliteKeywordRepository;
  let syncStateRepo: SqliteSyncStateRepository;
  let accountService: AccountManagementService;
  let keywordService: KeywordManagementService;
  let tweetMonitor: TweetMonitorService;
  let profileMonitor: ProfileMonitorService;

  beforeEach(() => {
    db = new SqliteDatabase(':memory:');
    clock = new ManualClock();
    notifier = new RecordingAlertNotifier();
    mockProvider = new MockTwitterProvider(clock, { autoEvents: false });

    accountRepo = new SqliteAccountRepository(db.connection);
    seenTweetRepo = new SqliteSeenTweetRepository(db.connection);
    keywordRepo = new SqliteKeywordRepository(db.connection);
    syncStateRepo = new SqliteSyncStateRepository(db.connection);

    keywordService = new KeywordManagementService(
      keywordRepo,
      syncStateRepo,
      clock,
      silentLogger,
    );
    keywordService.ensureDefaultsSeeded();

    accountService = new AccountManagementService(
      accountRepo,
      mockProvider,
      clock,
      silentLogger,
    );

    tweetMonitor = new TweetMonitorService(
      accountRepo,
      seenTweetRepo,
      keywordRepo,
      syncStateRepo,
      mockProvider,
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

    profileMonitor = new ProfileMonitorService(
      accountRepo,
      keywordRepo,
      syncStateRepo,
      mockProvider,
      notifier,
      clock,
      silentLogger,
      {
        maxUsersPerBatch: 50,
        consecutiveMissThreshold: 2,
      },
    );
  });

  afterEach(() => {
    db.close();
  });

  it('spends 0 API requests when 0 active accounts are tracked', async () => {
    const tSummary = await tweetMonitor.runCycle();
    const pSummary = await profileMonitor.runCycle();

    expect(tSummary.skipped).toBe(true);
    expect(pSummary.skipped).toBe(true);
    expect(mockProvider.getHealthSnapshot().totalRequests).toBe(0);
  });

  it('deduplicates tweets across overlap windows, respects baselineAt & reply toggles, and sorts chronologically', async () => {
    const addRes = await accountService.addAccount('https://x.com/Azuki');
    expect(addRes.status).toBe('ADDED');
    if (addRes.status !== 'ADDED') return;

    const reqCountAfterAdd = mockProvider.getHealthSnapshot().totalRequests;
    expect(reqCountAfterAdd).toBe(1);

    // Duplicate /add hits SQLite fast-path without spending an API call
    const dupRes = await accountService.addAccount('@azuki');
    expect(dupRes.status).toBe('ALREADY_TRACKED');
    expect(mockProvider.getHealthSnapshot().totalRequests).toBe(1);

    // 1) Historical tweet before baselineAt -> should be marked seen without alerting
    mockProvider.pushTweet({
      id: 'old_tweet',
      authorId: addRes.account.userId,
      authorHandle: 'azuki',
      authorDisplayName: 'Azuki',
      text: 'Old mint post',
      createdAtUnix: clock.currentSec - 30,
      url: 'https://x.com/azuki/status/old_tweet',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [],
    });

    // 2) Reply tweet (includeReplies defaults to false -> skipped)
    mockProvider.pushTweet({
      id: 'reply_1',
      authorId: addRes.account.userId,
      authorHandle: 'azuki',
      authorDisplayName: 'Azuki',
      text: '@someone gm!',
      createdAtUnix: clock.currentSec + 5,
      url: 'https://x.com/azuki/status/reply_1',
      isReply: true,
      inReplyToTweetId: 'parent_1',
      inReplyToHandle: 'someone',
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [],
    });

    // 3) Two eligible posts out of order -> must notify in chronological ASC order
    mockProvider.pushTweet({
      id: 'mint_2',
      authorId: addRes.account.userId,
      authorHandle: 'azuki',
      authorDisplayName: 'Azuki',
      text: 'Contract: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D Mint is LIVE!',
      createdAtUnix: clock.currentSec + 20,
      url: 'https://x.com/azuki/status/mint_2',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: ['https://claim.manifold.xyz/azuki'],
    });

    mockProvider.pushTweet({
      id: 'post_1',
      authorId: addRes.account.userId,
      authorHandle: 'azuki',
      authorDisplayName: 'Azuki',
      text: 'Preparing something special...',
      createdAtUnix: clock.currentSec + 10,
      url: 'https://x.com/azuki/status/post_1',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [],
    });

    clock.currentSec += 30;
    const cycle1 = await tweetMonitor.runCycle();
    expect(cycle1.tweetsFetched).toBe(4);
    expect(cycle1.alertsSent).toBe(2);

    expect(notifier.tweetAlerts.map((a) => a.tweet.id)).toEqual([
      'post_1',
      'mint_2',
    ]);
    expect(notifier.tweetAlerts[0]?.signal.priority).toBe('NORMAL');
    expect(notifier.tweetAlerts[1]?.signal.priority).toBe('HIGH');

    // Next cycle 30s later overlaps by 90s -> fetches same tweets, sends 0 duplicates!
    clock.currentSec += 30;
    const cycle2 = await tweetMonitor.runCycle();
    expect(cycle2.tweetsFetched).toBe(4);
    expect(cycle2.unseenTweets).toBe(0);
    expect(cycle2.alertsSent).toBe(0);
    expect(notifier.tweetAlerts).toHaveLength(2);
  });

  it('tracks immutable userId across @handle renames and enforces consecutive_misses >= 2 guard', async () => {
    const addRes = await accountService.addAccount('@boredapeyc');
    expect(addRes.status).toBe('ADDED');
    if (addRes.status !== 'ADDED') return;

    const userId = addRes.account.userId;

    // Rename @boredapeyc -> @bayc_official + stealth mint website
    mockProvider.seedUser({
      userId,
      handle: 'bayc_official',
      displayName: 'BAYC Official',
      bio: 'Allowlist claim live now!',
      websiteUrl: 'https://claim.manifold.xyz/bayc',
      avatarUrl: addRes.account.avatarUrl,
      bannerUrl: addRes.account.bannerUrl,
      availability: 'available',
      unavailableReason: null,
    });

    clock.currentSec += 60;
    const pCycle1 = await profileMonitor.runCycle();
    expect(pCycle1.changesDetected).toBe(1);
    expect(notifier.profileAlerts).toHaveLength(1);
    expect(notifier.profileAlerts[0]?.diff.priority).toBe('HIGH');

    // Stored handle in SQLite is updated to bayc_official so tweet search continues working!
    const updatedAccount = accountRepo.findByUserId(userId);
    expect(updatedAccount?.handle).toBe('bayc_official');

    mockProvider.pushTweet({
      id: 'post_after_rename',
      authorId: userId,
      authorHandle: 'bayc_official',
      authorDisplayName: 'BAYC Official',
      text: 'Mint open under our new handle!',
      createdAtUnix: clock.currentSec + 5,
      url: 'https://x.com/bayc_official/status/post_after_rename',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [],
    });

    clock.currentSec += 10;
    const tCycle = await tweetMonitor.runCycle();
    expect(tCycle.alertsSent).toBe(1);
    expect(notifier.tweetAlerts[0]?.tweet.id).toBe('post_after_rename');

    // Simulate transient omission from batch_info_by_ids:
    // Miss #1 -> should NOT alert yet
    mockProvider.removeUser(userId);
    clock.currentSec += 180;
    await profileMonitor.runCycle();
    expect(notifier.profileAlerts).toHaveLength(1);
    expect(accountRepo.findByUserId(userId)?.availability).toBe('available');
    expect(accountRepo.findByUserId(userId)?.consecutiveMisses).toBe(1);

    // Miss #2 -> reaches threshold (2) -> transitions to unavailable and alerts!
    clock.currentSec += 180;
    await profileMonitor.runCycle();
    expect(notifier.profileAlerts).toHaveLength(2);
    expect(accountRepo.findByUserId(userId)?.availability).toBe('unavailable');
  });

  it('preserves deleted default keywords across restarts and coordinates single-flight cycles', async () => {
    // Delete default 'live' keyword -> re-run ensureDefaultsSeeded -> 'live' stays deleted
    keywordService.removeKeywordFromInput('live');
    expect(keywordService.listKeywords()).not.toContain('live');

    keywordService.ensureDefaultsSeeded();
    expect(keywordService.listKeywords()).not.toContain('live');

    const maint = new MaintenanceService(
      seenTweetRepo,
      syncStateRepo,
      db,
      clock,
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
      mockProvider,
      clock,
      silentLogger,
      {
        tweetPollIntervalSec: 60,
        profilePollIntervalSec: 180,
        maintenanceIntervalSec: 3600,
      },
    );

    const [r1, r2] = await Promise.all([
      coordinator.runTweetCycleSingleFlight(),
      coordinator.runTweetCycleSingleFlight(),
    ]);
    expect(r1).toBe(r2);

    const testAlerts = new TestAlertService(notifier, keywordRepo, clock);
    await testAlerts.sendSimulatedAlerts();
    expect(notifier.tweetAlerts).toHaveLength(1);
    expect(notifier.tweetAlerts[0]?.isSimulated).toBe(true);
    expect(notifier.profileAlerts).toHaveLength(1);
    expect(notifier.profileAlerts[0]?.isSimulated).toBe(true);
  });

  it('boots and shuts down cleanly via Composition Root (createApplication) in MOCK_MODE', async () => {
    const config = loadAppConfig({
      TELEGRAM_BOT_TOKEN: '123456:TEST_FAKE_TOKEN_FOR_SMOKE',
      ADMIN_CHAT_IDS: '111222333,-100999888',
      MOCK_MODE: 'true',
      MOCK_AUTO_EVENTS: 'false',
      SQLITE_DB_PATH: ':memory:',
      LOG_LEVEL: 'error',
    });

    const app = createApplication(config, { skipTelegramPolling: true });
    await app.start();

    const added = await app.accountService.addAccount('@pudgypenguins');
    expect(added.status).toBe('ADDED');

    const check = await app.coordinator.runImmediateCheck();
    expect(check.tweetCycle.skipped).toBe(false);
    expect(check.profileCycle.skipped).toBe(false);

    const status = app.coordinator.getStatusSnapshot();
    expect(status.mode).toBe('MOCK');
    expect(status.accounts.active).toBe(1);

    await app.shutdown('smoke-test');
  });
});
