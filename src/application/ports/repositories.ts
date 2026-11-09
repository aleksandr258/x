import type {
  AccountAvailability,
  TrackedAccount,
} from '../../domain/entities/account.js';

export interface UpsertAccountInput {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly availability: AccountAvailability;
  readonly unavailableReason: string | null;
  readonly baselineAt: number;
  readonly nowUnix: number;
}

export interface UpdateProfileSnapshotInput {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly availability: AccountAvailability;
  readonly unavailableReason: string | null;
  readonly consecutiveMisses: number;
  readonly checkedAtUnix: number;
  readonly updatedAtUnix: number;
}

export interface AccountCounts {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly unavailable: number;
}

export interface PaginatedAccounts {
  readonly items: readonly TrackedAccount[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface AccountRepository {
  findByUserId(userId: string): TrackedAccount | null;
  findByHandle(handle: string): TrackedAccount | null;
  listActive(): TrackedAccount[];
  listAll(): TrackedAccount[];
  listPaginated(page: number, pageSize: number): PaginatedAccounts;
  getCounts(): AccountCounts;
  upsertNewAccount(input: UpsertAccountInput): TrackedAccount;
  updateProfileSnapshot(input: UpdateProfileSnapshotInput): void;
  recordConsecutiveMiss(
    userId: string,
    consecutiveMisses: number,
    markUnavailable: boolean,
    unavailableReason: string | null,
    checkedAtUnix: number,
  ): void;
  updateLastTweetSeenAt(userId: string, seenAtUnix: number): void;
  toggleIncludeReplies(userId: string, nowUnix: number): TrackedAccount | null;
  toggleEnabled(userId: string, nowUnix: number): TrackedAccount | null;
  deleteByUserId(userId: string): boolean;
  deleteByHandle(handle: string): TrackedAccount | null;
}

export interface SeenTweetRecord {
  readonly tweetId: string;
  readonly authorId: string;
  readonly createdAtUnix: number;
  readonly seenAtUnix: number;
}

export interface SeenTweetRepository {
  filterUnseenIds(tweetIds: readonly string[]): Set<string>;
  markSeen(record: SeenTweetRecord): void;
  markSeenBatch(records: readonly SeenTweetRecord[]): void;
  pruneOlderThan(cutoffUnix: number): number;
  count(): number;
}

export interface KeywordRepository {
  listAll(): string[];
  addMany(keywords: readonly string[], nowUnix: number): number;
  remove(keyword: string): boolean;
  count(): number;
}

export interface SyncStateRepository {
  get(key: string): string | null;
  set(key: string, value: string, nowUnix: number): void;
}

export interface DatabaseMaintainer {
  optimize(): void;
}
