import type { TrackedAccount } from '../../domain/entities/account.js';
import {
  HandleParser,
  type HandleParseErrorReason,
} from '../../domain/services/handle-parser.js';
import { ProfileDiffEngine } from '../../domain/services/profile-diff-engine.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  AccountCounts,
  AccountRepository,
  PaginatedAccounts,
} from '../ports/repositories.js';
import type { TwitterProvider } from '../ports/twitter-provider.js';

export type AddAccountResult =
  | {
      readonly status: 'ADDED';
      readonly account: TrackedAccount;
    }
  | {
      readonly status: 'ALREADY_TRACKED';
      readonly account: TrackedAccount;
      readonly previousHandle?: string;
    }
  | {
      readonly status: 'NOT_FOUND';
      readonly handle: string;
    }
  | {
      readonly status: 'INVALID_INPUT';
      readonly reason: HandleParseErrorReason;
    };

export type RemoveAccountResult =
  | {
      readonly status: 'REMOVED';
      readonly account: TrackedAccount;
    }
  | {
      readonly status: 'NOT_FOUND';
      readonly handle: string;
    }
  | {
      readonly status: 'INVALID_INPUT';
      readonly reason: HandleParseErrorReason;
    };

export class AccountManagementService {
  public constructor(
    private readonly accountRepo: AccountRepository,
    private readonly twitterProvider: TwitterProvider,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  public async addAccount(
    rawInput: string,
    signal?: AbortSignal,
  ): Promise<AddAccountResult> {
    const parsed = HandleParser.parse(rawInput);
    if (!parsed.ok) {
      return { status: 'INVALID_INPUT', reason: parsed.reason };
    }

    // Fast-path duplicate check before spending Twitter API credits
    // (Only trust cached handle without re-verifying on X if account is active & available;
    // paused or unavailable rows may have released or changed their @handle on X.)
    const existingByHandle = this.accountRepo.findByHandle(parsed.handle);
    if (
      existingByHandle !== null &&
      existingByHandle.enabled &&
      existingByHandle.availability === 'available'
    ) {
      return { status: 'ALREADY_TRACKED', account: existingByHandle };
    }

    const profile = await this.twitterProvider.getUserByHandle(parsed.handle, {
      priority: 'HIGH',
      signal,
    });

    if (
      profile === null ||
      profile.userId.trim().length === 0 ||
      (profile.availability === 'unavailable' && profile.handle.trim().length === 0)
    ) {
      return { status: 'NOT_FOUND', handle: parsed.handle };
    }

    const nowUnix = this.clock.nowUnix();
    const canonicalHandle = (
      profile.handle.trim().length > 0 ? profile.handle : parsed.handle
    ).toLowerCase();
    const canonicalAvatar = ProfileDiffEngine.normalizeAvatarUrl(profile.avatarUrl);
    const canonicalBanner = ProfileDiffEngine.normalizeBannerUrl(profile.bannerUrl);

    // Second check by immutable userId (in case tracked account recently changed @handle)
    const existingById = this.accountRepo.findByUserId(profile.userId);
    if (existingById !== null) {
      const previousHandle =
        existingById.handle.toLowerCase() !== canonicalHandle
          ? existingById.handle
          : undefined;

      this.accountRepo.updateProfileSnapshot({
        userId: existingById.userId,
        handle: canonicalHandle,
        displayName:
          profile.availability === 'available'
            ? profile.displayName.trim()
            : existingById.displayName,
        bio:
          profile.availability === 'available'
            ? profile.bio.replace(/\r\n/g, '\n').trim()
            : existingById.bio,
        websiteUrl:
          profile.availability === 'available'
            ? profile.websiteUrl?.trim() || null
            : existingById.websiteUrl,
        avatarUrl:
          profile.availability === 'available'
            ? canonicalAvatar
            : existingById.avatarUrl,
        bannerUrl:
          profile.availability === 'available'
            ? canonicalBanner
            : existingById.bannerUrl,
        availability: profile.availability,
        unavailableReason: profile.unavailableReason,
        consecutiveMisses: 0,
        checkedAtUnix: nowUnix,
        updatedAtUnix: nowUnix,
      });

      const refreshed = this.accountRepo.findByUserId(existingById.userId) ?? existingById;
      return {
        status: 'ALREADY_TRACKED',
        account: refreshed,
        previousHandle,
      };
    }

    const saved = this.accountRepo.upsertNewAccount({
      userId: profile.userId,
      handle: canonicalHandle,
      displayName: profile.displayName.trim(),
      bio: profile.bio.replace(/\r\n/g, '\n').trim(),
      websiteUrl: profile.websiteUrl?.trim() || null,
      avatarUrl: canonicalAvatar,
      bannerUrl: canonicalBanner,
      availability: profile.availability,
      unavailableReason: profile.unavailableReason,
      baselineAt: nowUnix,
      nowUnix,
    });

    this.logger.info('Added tracked X account', {
      userId: saved.userId,
      handle: saved.handle,
    });

    return { status: 'ADDED', account: saved };
  }

  public removeAccountByInput(rawInput: string): RemoveAccountResult {
    const parsed = HandleParser.parse(rawInput);
    if (!parsed.ok) {
      return { status: 'INVALID_INPUT', reason: parsed.reason };
    }

    const removed = this.accountRepo.deleteByHandle(parsed.handle);
    if (removed === null) {
      return { status: 'NOT_FOUND', handle: parsed.handle };
    }

    this.logger.info('Removed tracked X account by handle', {
      userId: removed.userId,
      handle: removed.handle,
    });

    return { status: 'REMOVED', account: removed };
  }

  public removeAccountByUserId(userId: string): TrackedAccount | null {
    const existing = this.accountRepo.findByUserId(userId);
    if (existing === null) {
      return null;
    }
    const deleted = this.accountRepo.deleteByUserId(userId);
    if (!deleted) {
      return null;
    }

    this.logger.info('Removed tracked X account by userId', {
      userId: existing.userId,
      handle: existing.handle,
    });

    return existing;
  }

  public getAccountByUserId(userId: string): TrackedAccount | null {
    return this.accountRepo.findByUserId(userId);
  }

  public listPaginated(page: number, pageSize = 8): PaginatedAccounts {
    return this.accountRepo.listPaginated(page, pageSize);
  }

  public listAll(): TrackedAccount[] {
    return this.accountRepo.listAll();
  }

  public getCounts(): AccountCounts {
    return this.accountRepo.getCounts();
  }

  public toggleIncludeReplies(userId: string): TrackedAccount | null {
    const updated = this.accountRepo.toggleIncludeReplies(
      userId,
      this.clock.nowUnix(),
    );
    if (updated !== null) {
      this.logger.info('Toggled includeReplies for tracked account', {
        userId: updated.userId,
        handle: updated.handle,
        includeReplies: updated.includeReplies,
      });
    }
    return updated;
  }

  public toggleEnabled(userId: string): TrackedAccount | null {
    const updated = this.accountRepo.toggleEnabled(userId, this.clock.nowUnix());
    if (updated !== null) {
      this.logger.info('Toggled enabled state for tracked account', {
        userId: updated.userId,
        handle: updated.handle,
        enabled: updated.enabled,
      });
    }
    return updated;
  }
}
