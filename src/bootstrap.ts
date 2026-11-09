import type { AlertNotifier } from './application/ports/alert-notifier.js';
import { SystemClock } from './application/ports/clock.js';
import type { Logger } from './application/ports/logger.js';
import type { TwitterProvider } from './application/ports/twitter-provider.js';
import { AccountManagementService } from './application/services/account-management-service.js';
import { KeywordManagementService } from './application/services/keyword-management-service.js';
import { MaintenanceService } from './application/services/maintenance-service.js';
import { MonitorCoordinator } from './application/services/monitor-coordinator.js';
import { ProfileMonitorService } from './application/services/profile-monitor-service.js';
import { TestAlertService } from './application/services/test-alert-service.js';
import { TweetMonitorService } from './application/services/tweet-monitor-service.js';
import type { AppConfig } from './config/env.js';
import { PinoLoggerAdapter } from './infrastructure/logging/pino-logger.js';
import { SqliteAccountRepository } from './infrastructure/persistence/sqlite-account-repository.js';
import { SqliteDatabase } from './infrastructure/persistence/sqlite-database.js';
import { SqliteKeywordRepository } from './infrastructure/persistence/sqlite-keyword-repository.js';
import { SqliteSeenTweetRepository } from './infrastructure/persistence/sqlite-seen-tweet-repository.js';
import { SqliteSyncStateRepository } from './infrastructure/persistence/sqlite-sync-state-repository.js';
import { TelegramAlertNotifier } from './infrastructure/telegram/telegram-alert-notifier.js';
import { TelegramBotAdapter } from './infrastructure/telegram/telegram-bot.js';
import { MockTwitterProvider } from './infrastructure/twitter/mock-twitter-provider.js';
import { RateLimitedHttpClient } from './infrastructure/twitter/rate-limited-http-client.js';
import { TwitterApiIoProvider } from './infrastructure/twitter/twitter-api-io-provider.js';

export interface BootstrapOptions {
  readonly skipTelegramPolling?: boolean;
}

export interface RunningApplication {
  readonly logger: Logger;
  readonly coordinator: MonitorCoordinator;
  readonly accountService: AccountManagementService;
  readonly keywordService: KeywordManagementService;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

export function createApplication(
  config: AppConfig,
  options: BootstrapOptions = {},
): RunningApplication {
  const clock = new SystemClock();
  const logger = PinoLoggerAdapter.create({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const sqliteDb = new SqliteDatabase(config.SQLITE_DB_PATH);
  const accountRepo = new SqliteAccountRepository(sqliteDb.connection);
  const seenTweetRepo = new SqliteSeenTweetRepository(sqliteDb.connection);
  const keywordRepo = new SqliteKeywordRepository(sqliteDb.connection);
  const syncStateRepo = new SqliteSyncStateRepository(sqliteDb.connection);

  const keywordService = new KeywordManagementService(
    keywordRepo,
    syncStateRepo,
    clock,
    logger.child({ component: 'keyword-service' }),
  );
  keywordService.ensureDefaultsSeeded();

  const maintenanceService = new MaintenanceService(
    seenTweetRepo,
    syncStateRepo,
    sqliteDb,
    clock,
    logger.child({ component: 'maintenance-service' }),
    config.SEEN_TWEETS_RETENTION_DAYS,
  );
  maintenanceService.runCleanup();

  let alertNotifierRef: AlertNotifier | null = null;

  const twitterProvider: TwitterProvider = config.MOCK_MODE
    ? new MockTwitterProvider(clock, { autoEvents: config.MOCK_AUTO_EVENTS })
    : new TwitterApiIoProvider(
        new RateLimitedHttpClient(
          clock,
          logger.child({ component: 'twitter-http' }),
          {
            minIntervalMs: config.TWITTER_MIN_INTERVAL_MS,
            timeoutMs: config.TWITTER_HTTP_TIMEOUT_MS,
            maxRetries: config.TWITTER_MAX_RETRIES,
            onAuthOrQuotaError: async (info) => {
              if (!alertNotifierRef) {
                return;
              }
              const message =
                info.statusCode === 402
                  ? 'Недостаточно кредитов на балансе TwitterAPI.io (HTTP 402 Payment Required). Пополните баланс или проверьте тариф. Сервис остаётся запущенным и автоматически возобновит мониторинг после восстановления лимитов.'
                  : `Ошибка авторизации ключа TWITTER_API_KEY в TwitterAPI.io (HTTP ${info.statusCode}). Проверьте ключ в конфигурации .env.`;

              await alertNotifierRef.sendSystemAlert({
                level: 'ERROR',
                title: `Ошибка TwitterAPI.io (HTTP ${info.statusCode})`,
                message,
                statusCode: info.statusCode,
                occurredAtUnix: info.occurredAtUnix,
              });
            },
          },
        ),
        clock,
        {
          baseUrl: config.TWITTER_API_BASE_URL,
          apiKey: config.TWITTER_API_KEY,
        },
      );

  const accountService = new AccountManagementService(
    accountRepo,
    twitterProvider,
    clock,
    logger.child({ component: 'account-service' }),
  );

  // Temporary proxy only if referenced during setup; real coordinator assigned right below before start()
  const telegramBotPlaceholderApi = {
    notifier: null as TelegramAlertNotifier | null,
  };

  const proxyNotifier: AlertNotifier = {
    sendTweetAlert: async (ev) => {
      if (telegramBotPlaceholderApi.notifier) {
        await telegramBotPlaceholderApi.notifier.sendTweetAlert(ev);
      }
    },
    sendProfileAlert: async (ev) => {
      if (telegramBotPlaceholderApi.notifier) {
        await telegramBotPlaceholderApi.notifier.sendProfileAlert(ev);
      }
    },
    sendSystemAlert: async (ev) => {
      if (telegramBotPlaceholderApi.notifier) {
        await telegramBotPlaceholderApi.notifier.sendSystemAlert(ev);
      }
    },
  };

  alertNotifierRef = proxyNotifier;

  const tweetMonitorService = new TweetMonitorService(
    accountRepo,
    seenTweetRepo,
    keywordRepo,
    syncStateRepo,
    twitterProvider,
    proxyNotifier,
    clock,
    logger.child({ component: 'tweet-monitor' }),
    {
      overlapBufferSec: config.TWEET_OVERLAP_BUFFER_SEC,
      coldStartLookbackSec: config.COLD_START_LOOKBACK_SEC,
      maxLookbackSec: config.MAX_LOOKBACK_SEC,
      maxHandlesPerBatch: config.MAX_HANDLES_PER_SEARCH_BATCH,
      maxQueryLength: config.MAX_SEARCH_QUERY_LENGTH,
      maxPagesPerBatch: config.MAX_PAGES_PER_SEARCH_BATCH,
    },
  );

  const profileMonitorService = new ProfileMonitorService(
    accountRepo,
    keywordRepo,
    syncStateRepo,
    twitterProvider,
    proxyNotifier,
    clock,
    logger.child({ component: 'profile-monitor' }),
    {
      maxUsersPerBatch: config.MAX_USERS_PER_PROFILE_BATCH,
      consecutiveMissThreshold: 2,
    },
  );

  const coordinator = new MonitorCoordinator(
    tweetMonitorService,
    profileMonitorService,
    maintenanceService,
    accountRepo,
    seenTweetRepo,
    keywordRepo,
    syncStateRepo,
    twitterProvider,
    clock,
    logger.child({ component: 'coordinator' }),
    {
      tweetPollIntervalSec: config.TWEET_POLL_INTERVAL_SEC,
      profilePollIntervalSec: config.PROFILE_POLL_INTERVAL_SEC,
      maintenanceIntervalSec: config.MAINTENANCE_INTERVAL_SEC,
    },
  );

  const testAlertService = new TestAlertService(
    proxyNotifier,
    keywordRepo,
    clock,
  );

  const telegramBot = new TelegramBotAdapter({
    token: config.TELEGRAM_BOT_TOKEN,
    adminChatIds: config.ADMIN_CHAT_IDS,
    mode: twitterProvider.mode,
    accountService,
    keywordService,
    coordinator,
    testAlertService,
    clock,
    logger: logger.child({ component: 'telegram-bot' }),
  });

  telegramBotPlaceholderApi.notifier = new TelegramAlertNotifier(
    telegramBot.bot.api,
    config.ADMIN_CHAT_IDS,
    logger.child({ component: 'telegram-notifier' }),
  );

  const rootAbortController = new AbortController();
  let shuttingDown = false;

  return {
    logger,
    coordinator,
    accountService,
    keywordService,

    async start(): Promise<void> {
      logger.info('Starting X NFT Account Monitor service', {
        mode: twitterProvider.mode,
        dbPath: config.SQLITE_DB_PATH,
        adminChatsCount: config.ADMIN_CHAT_IDS.length,
        tweetPollIntervalSec: config.TWEET_POLL_INTERVAL_SEC,
        profilePollIntervalSec: config.PROFILE_POLL_INTERVAL_SEC,
      });

      coordinator.start(rootAbortController.signal);

      if (!options.skipTelegramPolling) {
        await telegramBot.startPolling();
      }
    },

    async shutdown(reason = 'manual'): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      logger.info('Initiating graceful shutdown', { reason });
      rootAbortController.abort();

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutGuard = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          logger.warn('Graceful shutdown timeout reached, closing DB');
          resolve();
        }, 10_000);
        timeoutHandle.unref();
      });

      try {
        const stopTasks = async (): Promise<void> => {
          const tasks: Promise<unknown>[] = [coordinator.stop()];
          if (!options.skipTelegramPolling) {
            tasks.push(telegramBot.stopPolling());
          }
          await Promise.allSettled(tasks);
        };

        await Promise.race([stopTasks(), timeoutGuard]);
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        sqliteDb.close();
        logger.info('Graceful shutdown complete');
      }
    },
  };
}
