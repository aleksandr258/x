import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  AccountCounts,
  AccountRepository,
  KeywordRepository,
  SeenTweetRepository,
  SyncStateRepository,
} from '../ports/repositories.js';
import type {
  TwitterProvider,
  TwitterProviderHealthSnapshot,
} from '../ports/twitter-provider.js';
import {
  MaintenanceService,
  type MaintenanceSummary,
} from './maintenance-service.js';
import {
  LAST_PROFILE_POLL_UNIX_KEY,
  ProfileMonitorService,
  type ProfilePollCycleSummary,
} from './profile-monitor-service.js';
import {
  LAST_TWEET_POLL_UNIX_KEY,
  TweetMonitorService,
  type TweetPollCycleSummary,
} from './tweet-monitor-service.js';

export interface MonitorScheduleConfig {
  readonly tweetPollIntervalSec: number;
  readonly profilePollIntervalSec: number;
  readonly maintenanceIntervalSec: number;
}

export interface MonitorStatusSnapshot {
  readonly startedAtUnix: number;
  readonly uptimeSec: number;
  readonly mode: 'LIVE' | 'MOCK';
  readonly accounts: AccountCounts;
  readonly seenTweetsCount: number;
  readonly keywordsCount: number;
  readonly tweetPollIntervalSec: number;
  readonly profilePollIntervalSec: number;
  readonly lastTweetCycle: TweetPollCycleSummary | null;
  readonly lastTweetPollUnix: number | null;
  readonly lastTweetError: string | null;
  readonly lastProfileCycle: ProfilePollCycleSummary | null;
  readonly lastProfilePollUnix: number | null;
  readonly lastProfileError: string | null;
  readonly tweetCycleRunning: boolean;
  readonly profileCycleRunning: boolean;
  readonly providerHealth: TwitterProviderHealthSnapshot;
}

export interface ImmediateCheckResult {
  readonly tweetCycle: TweetPollCycleSummary;
  readonly profileCycle: ProfilePollCycleSummary;
}

export class MonitorCoordinator {
  private readonly startedAtUnix: number;
  private tweetInFlight: Promise<TweetPollCycleSummary> | null = null;
  private profileInFlight: Promise<ProfilePollCycleSummary> | null = null;
  private maintenanceInFlight: Promise<MaintenanceSummary> | null = null;

  private lastTweetCycle: TweetPollCycleSummary | null = null;
  private lastTweetError: string | null = null;
  private lastProfileCycle: ProfilePollCycleSummary | null = null;
  private lastProfileError: string | null = null;

  private loopAbortController: AbortController | null = null;
  private loopPromises: Promise<void>[] = [];

  public constructor(
    private readonly tweetMonitor: TweetMonitorService,
    private readonly profileMonitor: ProfileMonitorService,
    private readonly maintenanceService: MaintenanceService,
    private readonly accountRepo: AccountRepository,
    private readonly seenTweetRepo: SeenTweetRepository,
    private readonly keywordRepo: KeywordRepository,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly twitterProvider: TwitterProvider,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly schedule: MonitorScheduleConfig,
  ) {
    this.startedAtUnix = this.clock.nowUnix();
  }

  public start(parentSignal?: AbortSignal): void {
    if (this.loopAbortController !== null) {
      return;
    }

    const controller = new AbortController();
    this.loopAbortController = controller;

    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }

    const signal = controller.signal;

    this.loopPromises = [
      this.runPeriodicLoop(
        'tweet-monitor',
        this.schedule.tweetPollIntervalSec * 1000,
        0,
        signal,
        async (s) => {
          await this.runTweetCycleSingleFlight(s);
        },
      ),
      this.runPeriodicLoop(
        'profile-monitor',
        this.schedule.profilePollIntervalSec * 1000,
        2_000,
        signal,
        async (s) => {
          await this.runProfileCycleSingleFlight(s);
        },
      ),
      this.runPeriodicLoop(
        'db-maintenance',
        this.schedule.maintenanceIntervalSec * 1000,
        15_000,
        signal,
        async () => {
          await this.runMaintenanceSingleFlight();
        },
      ),
    ];

    this.logger.info('Started MonitorCoordinator background loops', {
      tweetPollIntervalSec: this.schedule.tweetPollIntervalSec,
      profilePollIntervalSec: this.schedule.profilePollIntervalSec,
      maintenanceIntervalSec: this.schedule.maintenanceIntervalSec,
    });
  }

  public async stop(): Promise<void> {
    if (this.loopAbortController !== null) {
      this.loopAbortController.abort();
    }

    await Promise.allSettled(this.loopPromises);

    const inFlight: Promise<unknown>[] = [];
    if (this.tweetInFlight !== null) {
      inFlight.push(this.tweetInFlight);
    }
    if (this.profileInFlight !== null) {
      inFlight.push(this.profileInFlight);
    }
    if (this.maintenanceInFlight !== null) {
      inFlight.push(this.maintenanceInFlight);
    }
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }

    this.loopPromises = [];
    this.loopAbortController = null;
    this.logger.info('Stopped MonitorCoordinator background loops');
  }

  public async runTweetCycleSingleFlight(
    signal?: AbortSignal,
  ): Promise<TweetPollCycleSummary> {
    if (this.tweetInFlight !== null) {
      return this.tweetInFlight;
    }

    const task = (async (): Promise<TweetPollCycleSummary> => {
      try {
        const summary = await this.tweetMonitor.runCycle(signal);
        this.lastTweetCycle = summary;
        this.lastTweetError = null;
        return summary;
      } catch (err) {
        if (!this.isAbortError(err)) {
          this.lastTweetError = this.formatErrorMessage(err);
        }
        throw err;
      } finally {
        this.tweetInFlight = null;
      }
    })();

    this.tweetInFlight = task;
    return task;
  }

  public async runProfileCycleSingleFlight(
    signal?: AbortSignal,
  ): Promise<ProfilePollCycleSummary> {
    if (this.profileInFlight !== null) {
      return this.profileInFlight;
    }

    const task = (async (): Promise<ProfilePollCycleSummary> => {
      try {
        const summary = await this.profileMonitor.runCycle(signal);
        this.lastProfileCycle = summary;
        this.lastProfileError = null;
        return summary;
      } catch (err) {
        if (!this.isAbortError(err)) {
          this.lastProfileError = this.formatErrorMessage(err);
        }
        throw err;
      } finally {
        this.profileInFlight = null;
      }
    })();

    this.profileInFlight = task;
    return task;
  }

  public async runMaintenanceSingleFlight(): Promise<MaintenanceSummary> {
    if (this.maintenanceInFlight !== null) {
      return this.maintenanceInFlight;
    }

    const task = (async (): Promise<MaintenanceSummary> => {
      try {
        return this.maintenanceService.runCleanup();
      } finally {
        this.maintenanceInFlight = null;
      }
    })();

    this.maintenanceInFlight = task;
    return task;
  }

  public async runImmediateCheck(
    signal?: AbortSignal,
  ): Promise<ImmediateCheckResult> {
    const effectiveSignal = signal ?? this.loopAbortController?.signal;
    const tweetCycle = await this.runTweetCycleSingleFlight(effectiveSignal);
    const profileCycle = await this.runProfileCycleSingleFlight(effectiveSignal);
    return { tweetCycle, profileCycle };
  }

  public getStatusSnapshot(): MonitorStatusSnapshot {
    const nowUnix = this.clock.nowUnix();
    const storedTweetUnix = this.parseStoredUnix(LAST_TWEET_POLL_UNIX_KEY);
    const storedProfileUnix = this.parseStoredUnix(LAST_PROFILE_POLL_UNIX_KEY);

    return {
      startedAtUnix: this.startedAtUnix,
      uptimeSec: Math.max(0, nowUnix - this.startedAtUnix),
      mode: this.twitterProvider.mode,
      accounts: this.accountRepo.getCounts(),
      seenTweetsCount: this.seenTweetRepo.count(),
      keywordsCount: this.keywordRepo.count(),
      tweetPollIntervalSec: this.schedule.tweetPollIntervalSec,
      profilePollIntervalSec: this.schedule.profilePollIntervalSec,
      lastTweetCycle: this.lastTweetCycle,
      lastTweetPollUnix:
        this.lastTweetCycle?.completedAtUnix ?? storedTweetUnix,
      lastTweetError: this.lastTweetError,
      lastProfileCycle: this.lastProfileCycle,
      lastProfilePollUnix:
        this.lastProfileCycle?.completedAtUnix ?? storedProfileUnix,
      lastProfileError: this.lastProfileError,
      tweetCycleRunning: this.tweetInFlight !== null,
      profileCycleRunning: this.profileInFlight !== null,
      providerHealth: this.twitterProvider.getHealthSnapshot(),
    };
  }

  private async runPeriodicLoop(
    loopName: string,
    intervalMs: number,
    initialDelayMs: number,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (initialDelayMs > 0) {
      await this.clock.sleep(initialDelayMs, signal);
    }

    while (!signal.aborted) {
      const startedMs = this.clock.nowMs();
      try {
        await work(signal);
      } catch (err) {
        if (signal.aborted || this.isAbortError(err)) {
          break;
        }
        this.logger.error(`Error in ${loopName} loop`, {
          error: this.formatErrorMessage(err),
        });
      }

      if (signal.aborted) {
        break;
      }

      const elapsedMs = this.clock.nowMs() - startedMs;
      const waitMs = Math.max(1000, intervalMs - elapsedMs);
      await this.clock.sleep(waitMs, signal);
    }
  }

  private parseStoredUnix(key: string): number | null {
    const raw = this.syncStateRepo.get(key);
    if (raw === null) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
  }

  private formatErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
