import { GrammyError, type Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertDeliveryError } from '../../src/application/ports/alert-notifier.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import { AccountManagementService } from '../../src/application/services/account-management-service.js';
import { KeywordManagementService } from '../../src/application/services/keyword-management-service.js';
import { MaintenanceService } from '../../src/application/services/maintenance-service.js';
import { MonitorCoordinator } from '../../src/application/services/monitor-coordinator.js';
import { ProfileMonitorService } from '../../src/application/services/profile-monitor-service.js';
import { TestAlertService } from '../../src/application/services/test-alert-service.js';
import { TweetMonitorService } from '../../src/application/services/tweet-monitor-service.js';
import type { TweetAlertEvent } from '../../src/domain/entities/alerts.js';
import { SqliteAccountRepository } from '../../src/infrastructure/persistence/sqlite-account-repository.js';
import { SqliteDatabase } from '../../src/infrastructure/persistence/sqlite-database.js';
import { SqliteKeywordRepository } from '../../src/infrastructure/persistence/sqlite-keyword-repository.js';
import { SqliteSeenTweetRepository } from '../../src/infrastructure/persistence/sqlite-seen-tweet-repository.js';
import { SqliteSyncStateRepository } from '../../src/infrastructure/persistence/sqlite-sync-state-repository.js';
import { TelegramAlertNotifier } from '../../src/infrastructure/telegram/telegram-alert-notifier.js';
import { TelegramBotAdapter } from '../../src/infrastructure/telegram/telegram-bot.js';
import { MockTwitterProvider } from '../../src/infrastructure/twitter/mock-twitter-provider.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const fakeBotInfo: UserFromGetMe = {
  id: 999888777,
  is_bot: true,
  first_name: 'NFTMonitorBot',
  username: 'nft_monitor_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function makeSampleTweetEvent(): TweetAlertEvent {
  return {
    account: {
      userId: '1001',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      includeReplies: false,
      enabled: true,
      availability: 'available',
      unavailableReason: null,
      consecutiveMisses: 0,
      baselineAt: 1700000000,
      lastTweetSeenAt: null,
      lastProfileCheckedAt: null,
      createdAt: 1700000000,
      updatedAt: 1700000000,
    },
    kind: 'POST',
    tweet: {
      id: '555',
      authorId: '1001',
      authorHandle: 'azuki',
      authorDisplayName: 'Azuki',
      text: 'Mint is LIVE! 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
      createdAtUnix: 1700000100,
      url: 'https://x.com/azuki/status/555',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [],
    },
    signal: {
      priority: 'HIGH',
      matchedKeywords: ['mint', 'live'],
      evmAddresses: ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'],
      links: [],
    },
  };
}

describe('TelegramAlertNotifier & TelegramBotAdapter Production Resilience', () => {
  it('isolates per-admin fanout errors so one blocked chat does not break valid chats or cause duplicate retries', async () => {
    const sentTo: string[] = [];
    const fakeApi = {
      sendMessage: async (chatId: string | number) => {
        const id = String(chatId);
        if (id === 'blocked_admin') {
          throw new GrammyError(
            'Forbidden: bot was blocked by the user',
            {
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            },
            'sendMessage',
            {},
          );
        }
        sentTo.push(id);
        return {};
      },
    } as unknown as Api;

    const notifier = new TelegramAlertNotifier(
      fakeApi,
      ['blocked_admin', 'valid_admin_1', 'valid_admin_2'],
      silentLogger,
    );

    await expect(
      notifier.sendTweetAlert(makeSampleTweetEvent()),
    ).resolves.toBeUndefined();
    expect(sentTo).toEqual(['valid_admin_1', 'valid_admin_2']);
  });

  it('falls back to plain text on HTTP 400 entity parse rejection and classifies retryable vs non-retryable failures', async () => {
    const calls: { text: string; parseMode?: string }[] = [];
    const entityRejectApi = {
      sendMessage: async (
        _chatId: string | number,
        text: string,
        other?: { parse_mode?: string },
      ) => {
        calls.push({ text, parseMode: other?.parse_mode });
        if (other?.parse_mode === 'HTML') {
          throw new GrammyError(
            "Bad Request: can't parse entities",
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: can't parse entities",
            },
            'sendMessage',
            {},
          );
        }
        return {};
      },
    } as unknown as Api;

    const fallbackNotifier = new TelegramAlertNotifier(
      entityRejectApi,
      ['100'],
      silentLogger,
    );
    await expect(
      fallbackNotifier.sendTweetAlert(makeSampleTweetEvent()),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.parseMode).toBe('HTML');
    expect(calls[1]?.parseMode).toBeUndefined();
    expect(calls[1]?.text).toContain('0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');

    // All chats fail with 403 -> AlertDeliveryError(retryable: false)
    const allBlockedApi = {
      sendMessage: async () => {
        throw new GrammyError(
          'Forbidden: bot was blocked by the user',
          { ok: false, error_code: 403, description: 'Forbidden' },
          'sendMessage',
          {},
        );
      },
    } as unknown as Api;
    const blockedNotifier = new TelegramAlertNotifier(
      allBlockedApi,
      ['100', '200'],
      silentLogger,
    );
    await expect(
      blockedNotifier.sendTweetAlert(makeSampleTweetEvent()),
    ).rejects.toMatchObject({
      name: 'AlertDeliveryError',
      retryable: false,
    } satisfies Partial<AlertDeliveryError>);

    // All chats fail with 502 / ECONNRESET -> AlertDeliveryError(retryable: true)
    const transientFailApi = {
      sendMessage: async () => {
        throw new Error('fetch failed: ECONNRESET');
      },
    } as unknown as Api;
    const transientNotifier = new TelegramAlertNotifier(
      transientFailApi,
      ['100'],
      silentLogger,
    );
    await expect(
      transientNotifier.sendTweetAlert(makeSampleTweetEvent()),
    ).rejects.toMatchObject({
      name: 'AlertDeliveryError',
      retryable: true,
    } satisfies Partial<AlertDeliveryError>);
  });

  describe('TelegramBotAdapter interactive flows, callback_data limits & long-polling supervision', () => {
    let db: SqliteDatabase;
    let botAdapter: TelegramBotAdapter;
    let accountRepo: SqliteAccountRepository;
    let apiCalls: { method: string; payload: Record<string, unknown> }[];

    const fastClock: Clock = {
      nowMs: () => 1_762_610_000_000,
      nowUnix: () => 1_762_610_000,
      sleep: async () => {},
    };

    beforeEach(() => {
      db = new SqliteDatabase(':memory:');
      accountRepo = new SqliteAccountRepository(db.connection);
      const seenRepo = new SqliteSeenTweetRepository(db.connection);
      const kwRepo = new SqliteKeywordRepository(db.connection);
      const syncRepo = new SqliteSyncStateRepository(db.connection);
      const mockTwitter = new MockTwitterProvider(fastClock);

      const kwSvc = new KeywordManagementService(
        kwRepo,
        syncRepo,
        fastClock,
        silentLogger,
      );
      kwSvc.ensureDefaultsSeeded();

      const acctSvc = new AccountManagementService(
        accountRepo,
        mockTwitter,
        fastClock,
        silentLogger,
      );
      const noopNotifier = {
        sendTweetAlert: async () => {},
        sendProfileAlert: async () => {},
        sendSystemAlert: async () => {},
      };
      const tweetSvc = new TweetMonitorService(
        accountRepo,
        seenRepo,
        kwRepo,
        syncRepo,
        mockTwitter,
        noopNotifier,
        fastClock,
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
      const profSvc = new ProfileMonitorService(
        accountRepo,
        kwRepo,
        syncRepo,
        mockTwitter,
        noopNotifier,
        fastClock,
        silentLogger,
        { maxUsersPerBatch: 50 },
      );
      const maintSvc = new MaintenanceService(
        seenRepo,
        syncRepo,
        db,
        fastClock,
        silentLogger,
        7,
      );
      const coord = new MonitorCoordinator(
        tweetSvc,
        profSvc,
        maintSvc,
        accountRepo,
        seenRepo,
        kwRepo,
        syncRepo,
        mockTwitter,
        fastClock,
        silentLogger,
        {
          tweetPollIntervalSec: 60,
          profilePollIntervalSec: 180,
          maintenanceIntervalSec: 3600,
        },
      );
      const testAlertSvc = new TestAlertService(noopNotifier, kwRepo, fastClock);

      botAdapter = new TelegramBotAdapter({
        token: '12345:FAKE_TOKEN',
        adminChatIds: ['777000'],
        mode: 'MOCK',
        accountService: acctSvc,
        keywordService: kwSvc,
        coordinator: coord,
        testAlertService: testAlertSvc,
        clock: fastClock,
        logger: silentLogger,
        botInfo: fakeBotInfo,
      });

      apiCalls = [];
      botAdapter.bot.api.config.use(async (_prev, method, payload) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        apiCalls.push({ method, payload: p });
        if (method === 'sendMessage') {
          return {
            ok: true,
            result: {
              message_id: 42,
              date: 1762610000,
              chat: { id: Number(p['chat_id'] ?? 777000), type: 'private' },
              text: String(p['text'] ?? ''),
            } as never,
          };
        }
        return { ok: true, result: true as never };
      });
    });

    afterEach(() => {
      db.close();
    });

    it('blocks unauthorized chats and guarantees <= 64-byte callback_data even for 15-char handles and oversized userIds', async () => {
      // 1) Unauthorized user blocked
      await botAdapter.bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1762610000,
          chat: { id: 999999, type: 'private', first_name: 'Intruder' },
          from: { id: 999999, is_bot: false, first_name: 'Intruder' },
          text: '/list',
          entities: [{ offset: 0, length: 5, type: 'bot_command' }],
        },
      } satisfies Update);

      expect(apiCalls).toHaveLength(1);
      expect(apiCalls[0]?.payload['text']).toContain('Доступ запрещён');

      // 2) Seed accounts with 15-char handle + 20-digit Snowflake ID + pathological 80-char colon ID
      accountRepo.upsertNewAccount({
        userId: '18446744073709551615',
        handle: 'fifteen_char_id',
        displayName: '15 Char Handle',
        bio: '',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
        baselineAt: 1000,
        nowUnix: 1000,
      });
      const hugeColonId = `custom:id:${'9'.repeat(75)}`;
      accountRepo.upsertNewAccount({
        userId: hugeColonId,
        handle: 'oversized_uid_x',
        displayName: 'Oversized UID',
        bio: '',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
        baselineAt: 1000,
        nowUnix: 1000,
      });

      apiCalls.length = 0;
      await botAdapter.bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1762610001,
          chat: { id: 777000, type: 'private', first_name: 'Admin' },
          from: { id: 777000, is_bot: false, first_name: 'Admin' },
          text: '/list',
          entities: [{ offset: 0, length: 5, type: 'bot_command' }],
        },
      } satisfies Update);

      expect(apiCalls).toHaveLength(1);
      const markup = apiCalls[0]?.payload['reply_markup'] as {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
      const allButtons = markup.inline_keyboard.flat();
      expect(allButtons.length).toBeGreaterThanOrEqual(6);

      for (const btn of allButtons) {
        expect(
          Buffer.byteLength(btn.callback_data, 'utf8'),
          `callback_data "${btn.callback_data}" must be <= 64 bytes`,
        ).toBeLessThanOrEqual(64);
      }

      // Click the compact-token replies toggle button for hugeColonId and verify it decodes & toggles!
      const compactToggleBtn = allButtons.find(
        (b) => b.callback_data.startsWith('r:~'),
      );
      expect(compactToggleBtn).toBeDefined();

      await botAdapter.bot.handleUpdate({
        update_id: 3,
        callback_query: {
          id: 'cb_1',
          from: { id: 777000, is_bot: false, first_name: 'Admin' },
          chat_instance: 'ci_1',
          message: {
            message_id: 42,
            date: 1762610001,
            chat: { id: 777000, type: 'private', first_name: 'Admin' },
            text: 'list',
          },
          data: compactToggleBtn!.callback_data,
        },
      } satisfies Update);

      expect(accountRepo.findByUserId(hugeColonId)?.includeReplies).toBe(true);
    });

    it('supervises long-polling across 409 Conflict / 502 drops without unhandledRejection and stops cleanly', async () => {
      let startCalls = 0;
      botAdapter.bot.start = async (opts) => {
        startCalls += 1;
        if (startCalls === 1) {
          throw new GrammyError(
            'Conflict: terminated by other getUpdates request',
            { ok: false, error_code: 409, description: 'Conflict' },
            'getUpdates',
            {},
          );
        }
        await opts?.onStart?.(fakeBotInfo);
      };
      botAdapter.bot.stop = async () => {
        throw new Error('ECONNRESET on final getUpdates offset save');
      };

      await expect(botAdapter.startPolling()).resolves.toBeUndefined();
      // Allow supervised loop microtasks to complete retry
      await new Promise((r) => setTimeout(r, 15));
      expect(startCalls).toBe(2);

      // stopPolling() catches bot.stop() network error cleanly without throwing
      await expect(botAdapter.stopPolling()).resolves.toBeUndefined();
    });
  });
});
