import type {
  TrackedAccount,
  TwitterUserProfile,
} from '../../domain/entities/account.js';
import { ProfileDiffEngine } from '../../domain/services/profile-diff-engine.js';
import {
  isNonRetryableDeliveryError,
  type AlertNotifier,
} from '../ports/alert-notifier.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  AccountRepository,
  KeywordRepository,
  SyncStateRepository,
} from '../ports/repositories.js';
import type { TwitterProvider } from '../ports/twitter-provider.js';

export const LAST_PROFILE_POLL_UNIX_KEY = 'last_profile_poll_unix';
const HARD_MAX_USERS_PER_BATCH = 100;

export interface ProfileMonitorOptions {
  readonly maxUsersPerBatch: number;
  readonly consecutiveMissThreshold?: number;
}

export interface ProfilePollCycleSummary {
  readonly skipped: boolean;
  readonly activeAccounts: number;
  readonly batchesQueried: number;
  readonly profilesFetched: number;
  readonly changesDetected: number;
  readonly alertsSent: number;
  readonly completedAtUnix: number;
}

export class ProfileMonitorService {
  private readonly missThreshold: number;
  private readonly batchSize: number;

  public constructor(
    private readonly accountRepo: AccountRepository,
    private readonly keywordRepo: KeywordRepository,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly twitterProvider: TwitterProvider,
    private readonly alertNotifier: AlertNotifier,
    private readonly clock: Clock,
    private readonly logger: Logger,
    options: ProfileMonitorOptions,
  ) {
    this.missThreshold = Math.max(1, options.consecutiveMissThreshold ?? 2);
    this.batchSize = Math.min(
      HARD_MAX_USERS_PER_BATCH,
      Math.max(1, Math.floor(options.maxUsersPerBatch)),
    );
  }

  public async runCycle(signal?: AbortSignal): Promise<ProfilePollCycleSummary> {
    const cycleStartUnix = this.clock.nowUnix();
    const activeAccounts = this.accountRepo.listActive();

    if (activeAccounts.length === 0) {
      this.logger.debug('Skipping profile poll cycle: 0 active accounts');
      return {
        skipped: true,
        activeAccounts: 0,
        batchesQueried: 0,
        profilesFetched: 0,
        changesDetected: 0,
        alertsSent: 0,
        completedAtUnix: cycleStartUnix,
      };
    }

    const chunks = this.chunkAccounts(activeAccounts, this.batchSize);
    const keywords = this.keywordRepo.listAll();
    const cycleErrors: unknown[] = [];

    let batchesQueried = 0;
    let profilesFetched = 0;
    let changesDetected = 0;
    let alertsSent = 0;

    for (const chunk of chunks) {
      this.throwIfAborted(signal);
      batchesQueried += 1;

      let profiles: readonly TwitterUserProfile[];
      try {
        profiles = await this.twitterProvider.getUsersByIds(
          chunk.map((a) => a.userId),
          { priority: 'NORMAL', signal },
        );
      } catch (err) {
        if (signal?.aborted || this.isAbortError(err)) {
          throw err;
        }
        cycleErrors.push(err);
        this.logger.error('Failed to poll profile batch; continuing remaining batches', {
          accountsInBatch: chunk.length,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      profilesFetched += profiles.length;

      const profileById = new Map<string, TwitterUserProfile>();
      for (const profile of profiles) {
        profileById.set(profile.userId, profile);
      }

      for (const account of chunk) {
        this.throwIfAborted(signal);
        const nowUnix = this.clock.nowUnix();
        const fresh = profileById.get(account.userId);

        if (fresh === undefined) {
          try {
            const handled = await this.handleMissingProfile(
              account,
              keywords,
              nowUnix,
            );
            if (handled.changed) {
              changesDetected += 1;
              if (handled.alertDelivered) {
                alertsSent += 1;
              }
            }
          } catch (err) {
            if (signal?.aborted || this.isAbortError(err)) {
              throw err;
            }
            cycleErrors.push(err);
            this.logger.error(
              'Transient error handling missing profile alert; will retry next cycle',
              {
                userId: account.userId,
                handle: account.handle,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
          continue;
        }

        const canonicalProfile: TwitterUserProfile = {
          ...fresh,
          handle:
            fresh.handle.trim().length > 0
              ? fresh.handle.trim().toLowerCase()
              : account.handle,
          avatarUrl: ProfileDiffEngine.normalizeAvatarUrl(fresh.avatarUrl),
          bannerUrl: ProfileDiffEngine.normalizeBannerUrl(fresh.bannerUrl),
        };

        const diff = ProfileDiffEngine.diff(account, canonicalProfile, keywords);

        if (diff.hasChanges) {
          changesDetected += 1;
          try {
            await this.alertNotifier.sendProfileAlert({
              account,
              freshProfile: canonicalProfile,
              diff,
              detectedAtUnix: nowUnix,
            });
            alertsSent += 1;
          } catch (err) {
            if (signal?.aborted || this.isAbortError(err)) {
              throw err;
            }

            if (!isNonRetryableDeliveryError(err)) {
              cycleErrors.push(err);
              this.logger.error(
                'Transient error delivering profile alert; leaving stored snapshot unchanged for retry',
                {
                  userId: account.userId,
                  handle: canonicalProfile.handle,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              continue;
            }

            this.logger.error(
              'Non-retryable client error delivering profile alert; updating snapshot to avoid infinite loop',
              {
                userId: account.userId,
                handle: canonicalProfile.handle,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }

        if (canonicalProfile.availability === 'unavailable') {
          this.accountRepo.updateProfileSnapshot({
            userId: account.userId,
            handle: canonicalProfile.handle,
            displayName: account.displayName,
            bio: account.bio,
            websiteUrl: account.websiteUrl,
            avatarUrl: account.avatarUrl,
            bannerUrl: account.bannerUrl,
            availability: 'unavailable',
            unavailableReason: canonicalProfile.unavailableReason,
            consecutiveMisses: 0,
            checkedAtUnix: nowUnix,
            updatedAtUnix: diff.hasChanges ? nowUnix : account.updatedAt,
          });
        } else {
          this.accountRepo.updateProfileSnapshot({
            userId: account.userId,
            handle: canonicalProfile.handle,
            displayName: canonicalProfile.displayName.trim(),
            bio: canonicalProfile.bio.replace(/\r\n/g, '\n').trim(),
            websiteUrl: canonicalProfile.websiteUrl?.trim() || null,
            avatarUrl: canonicalProfile.avatarUrl,
            bannerUrl: canonicalProfile.bannerUrl,
            availability: 'available',
            unavailableReason: null,
            consecutiveMisses: 0,
            checkedAtUnix: nowUnix,
            updatedAtUnix: diff.hasChanges ? nowUnix : account.updatedAt,
          });
        }
      }
    }

    if (cycleErrors.length > 0) {
      throw cycleErrors[0];
    }

    const completedAtUnix = this.clock.nowUnix();
    this.syncStateRepo.set(
      LAST_PROFILE_POLL_UNIX_KEY,
      String(cycleStartUnix),
      completedAtUnix,
    );

    const summary: ProfilePollCycleSummary = {
      skipped: false,
      activeAccounts: activeAccounts.length,
      batchesQueried,
      profilesFetched,
      changesDetected,
      alertsSent,
      completedAtUnix,
    };

    this.logger.info('Completed profile poll cycle', { ...summary });
    return summary;
  }

  private async handleMissingProfile(
    account: TrackedAccount,
    keywords: readonly string[],
    nowUnix: number,
  ): Promise<{ changed: boolean; alertDelivered: boolean }> {
    const nextMisses = account.consecutiveMisses + 1;
    const markUnavailable = nextMisses >= this.missThreshold;
    const reason = 'Аккаунт отсутствует в ответе X API (удалён или заблокирован)';

    let changed = false;
    let alertDelivered = false;

    if (markUnavailable && account.availability !== 'unavailable') {
      const syntheticProfile: TwitterUserProfile = {
        userId: account.userId,
        handle: account.handle,
        displayName: account.displayName,
        bio: account.bio,
        websiteUrl: account.websiteUrl,
        avatarUrl: account.avatarUrl,
        bannerUrl: account.bannerUrl,
        availability: 'unavailable',
        unavailableReason: reason,
      };

      const diff = ProfileDiffEngine.diff(account, syntheticProfile, keywords);
      if (diff.hasChanges) {
        changed = true;
        try {
          await this.alertNotifier.sendProfileAlert({
            account,
            freshProfile: syntheticProfile,
            diff,
            detectedAtUnix: nowUnix,
          });
          alertDelivered = true;
        } catch (err) {
          if (!isNonRetryableDeliveryError(err)) {
            throw err;
          }
          this.logger.error(
            'Non-retryable client error delivering missing-profile alert; persisting unavailable state',
            {
              userId: account.userId,
              handle: account.handle,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    this.accountRepo.recordConsecutiveMiss(
      account.userId,
      nextMisses,
      markUnavailable,
      markUnavailable ? reason : account.unavailableReason,
      nowUnix,
    );

    return { changed, alertDelivered };
  }

  private chunkAccounts(
    accounts: readonly TrackedAccount[],
    chunkSize: number,
  ): TrackedAccount[][] {
    const chunks: TrackedAccount[][] = [];
    for (let i = 0; i < accounts.length; i += chunkSize) {
      chunks.push(accounts.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('Profile monitor cycle aborted');
      err.name = 'AbortError';
      throw err;
    }
  }
}
