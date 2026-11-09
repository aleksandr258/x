import type Database from 'better-sqlite3';
import type {
  AccountCounts,
  AccountRepository,
  PaginatedAccounts,
  UpdateProfileSnapshotInput,
  UpsertAccountInput,
} from '../../application/ports/repositories.js';
import type {
  AccountAvailability,
  TrackedAccount,
} from '../../domain/entities/account.js';

interface TrackedAccountRow {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string;
  website_url: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  include_replies: number;
  enabled: number;
  availability: string;
  unavailable_reason: string | null;
  consecutive_misses: number;
  baseline_at: number;
  last_tweet_seen_at: number | null;
  last_profile_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CountsRow {
  total: number;
  active: number | null;
  paused: number | null;
  unavailable: number | null;
}

export class SqliteAccountRepository implements AccountRepository {
  public constructor(private readonly db: Database.Database) {}

  public findByUserId(userId: string): TrackedAccount | null {
    const row = this.db
      .prepare<[string], TrackedAccountRow>(
        'SELECT * FROM tracked_accounts WHERE user_id = ?',
      )
      .get(userId);
    return row ? this.mapRow(row) : null;
  }

  public findByHandle(handle: string): TrackedAccount | null {
    const normalized = handle.trim().replace(/^@+/, '').toLowerCase();
    const row = this.db
      .prepare<[string], TrackedAccountRow>(
        'SELECT * FROM tracked_accounts WHERE handle = ? COLLATE NOCASE LIMIT 1',
      )
      .get(normalized);
    return row ? this.mapRow(row) : null;
  }

  public listActive(): TrackedAccount[] {
    const rows = this.db
      .prepare<[], TrackedAccountRow>(
        'SELECT * FROM tracked_accounts WHERE enabled = 1 ORDER BY handle COLLATE NOCASE ASC',
      )
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  public listAll(): TrackedAccount[] {
    const rows = this.db
      .prepare<[], TrackedAccountRow>(
        'SELECT * FROM tracked_accounts ORDER BY created_at DESC, handle COLLATE NOCASE ASC',
      )
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  public listPaginated(page: number, pageSize: number): PaginatedAccounts {
    const safePageSize = Math.max(1, Math.min(50, Math.floor(pageSize)));
    const countRow = this.db
      .prepare<[], { cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM tracked_accounts',
      )
      .get();
    const total = countRow?.cnt ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, Math.floor(page)), totalPages);
    const offset = (safePage - 1) * safePageSize;

    const rows = this.db
      .prepare<[number, number], TrackedAccountRow>(
        `SELECT * FROM tracked_accounts
         ORDER BY enabled DESC, handle COLLATE NOCASE ASC
         LIMIT ? OFFSET ?`,
      )
      .all(safePageSize, offset);

    return {
      items: rows.map((row) => this.mapRow(row)),
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages,
    };
  }

  public getCounts(): AccountCounts {
    const row = this.db
      .prepare<[], CountsRow>(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN availability = 'unavailable' THEN 1 ELSE 0 END) AS unavailable
         FROM tracked_accounts`,
      )
      .get();

    return {
      total: row?.total ?? 0,
      active: row?.active ?? 0,
      paused: row?.paused ?? 0,
      unavailable: row?.unavailable ?? 0,
    };
  }

  public upsertNewAccount(input: UpsertAccountInput): TrackedAccount {
    const normalizedHandle = input.handle.trim().toLowerCase();

    const tx = this.db.transaction(() => {
      this.displaceConflictingHandles(
        normalizedHandle,
        input.userId,
        input.nowUnix,
      );

      this.db
        .prepare(
          `INSERT INTO tracked_accounts (
             user_id, handle, display_name, bio, website_url, avatar_url, banner_url,
             include_replies, enabled, availability, unavailable_reason,
             consecutive_misses, baseline_at, last_tweet_seen_at, last_profile_checked_at,
             created_at, updated_at
           ) VALUES (
             @userId, @handle, @displayName, @bio, @websiteUrl, @avatarUrl, @bannerUrl,
             0, 1, @availability, @unavailableReason,
             0, @baselineAt, NULL, @nowUnix,
             @nowUnix, @nowUnix
           )
           ON CONFLICT(user_id) DO UPDATE SET
             handle = excluded.handle,
             display_name = excluded.display_name,
             bio = excluded.bio,
             website_url = excluded.website_url,
             avatar_url = excluded.avatar_url,
             banner_url = excluded.banner_url,
             availability = excluded.availability,
             unavailable_reason = excluded.unavailable_reason,
             consecutive_misses = 0,
             last_profile_checked_at = excluded.last_profile_checked_at,
             updated_at = excluded.updated_at`,
        )
        .run({
          userId: input.userId,
          handle: normalizedHandle,
          displayName: input.displayName,
          bio: input.bio,
          websiteUrl: input.websiteUrl,
          avatarUrl: input.avatarUrl,
          bannerUrl: input.bannerUrl,
          availability: input.availability,
          unavailableReason: input.unavailableReason,
          baselineAt: input.baselineAt,
          nowUnix: input.nowUnix,
        });
    });

    tx();

    const saved = this.findByUserId(input.userId);
    if (saved === null) {
      throw new Error(`Failed to load upserted account ${input.userId}`);
    }
    return saved;
  }

  public updateProfileSnapshot(input: UpdateProfileSnapshotInput): void {
    const normalizedHandle = input.handle.trim().toLowerCase();

    const tx = this.db.transaction(() => {
      this.displaceConflictingHandles(
        normalizedHandle,
        input.userId,
        input.updatedAtUnix,
      );

      this.db
        .prepare(
          `UPDATE tracked_accounts
           SET handle = @handle,
               display_name = @displayName,
               bio = @bio,
               website_url = @websiteUrl,
               avatar_url = @avatarUrl,
               banner_url = @bannerUrl,
               availability = @availability,
               unavailable_reason = @unavailableReason,
               consecutive_misses = @consecutiveMisses,
               last_profile_checked_at = @checkedAtUnix,
               updated_at = @updatedAtUnix
           WHERE user_id = @userId`,
        )
        .run({
          userId: input.userId,
          handle: normalizedHandle,
          displayName: input.displayName,
          bio: input.bio,
          websiteUrl: input.websiteUrl,
          avatarUrl: input.avatarUrl,
          bannerUrl: input.bannerUrl,
          availability: input.availability,
          unavailableReason: input.unavailableReason,
          consecutiveMisses: input.consecutiveMisses,
          checkedAtUnix: input.checkedAtUnix,
          updatedAtUnix: input.updatedAtUnix,
        });
    });

    tx();
  }

  private displaceConflictingHandles(
    normalizedHandle: string,
    ownerUserId: string,
    nowUnix: number,
  ): void {
    const conflicts = this.db
      .prepare<[string, string], { user_id: string; handle: string }>(
        `SELECT user_id, handle
         FROM tracked_accounts
         WHERE handle = ? COLLATE NOCASE AND user_id != ?`,
      )
      .all(normalizedHandle, ownerUserId);

    if (conflicts.length === 0) {
      return;
    }

    const displaceStmt = this.db.prepare<[string, number, string]>(
      `UPDATE tracked_accounts
       SET handle = ?, updated_at = ?
       WHERE user_id = ?`,
    );

    for (const row of conflicts) {
      const baseHandle = row.handle.split('#')[0] || 'account';
      const displacedHandle = `${baseHandle}#${row.user_id}`;
      displaceStmt.run(displacedHandle, nowUnix, row.user_id);
    }
  }

  public recordConsecutiveMiss(
    userId: string,
    consecutiveMisses: number,
    markUnavailable: boolean,
    unavailableReason: string | null,
    checkedAtUnix: number,
  ): void {
    if (markUnavailable) {
      this.db
        .prepare(
          `UPDATE tracked_accounts
           SET consecutive_misses = ?,
               availability = 'unavailable',
               unavailable_reason = ?,
               last_profile_checked_at = ?,
               updated_at = ?
           WHERE user_id = ?`,
        )
        .run(
          consecutiveMisses,
          unavailableReason,
          checkedAtUnix,
          checkedAtUnix,
          userId,
        );
    } else {
      this.db
        .prepare(
          `UPDATE tracked_accounts
           SET consecutive_misses = ?,
               last_profile_checked_at = ?
           WHERE user_id = ?`,
        )
        .run(consecutiveMisses, checkedAtUnix, userId);
    }
  }

  public updateLastTweetSeenAt(userId: string, seenAtUnix: number): void {
    this.db
      .prepare(
        `UPDATE tracked_accounts
         SET last_tweet_seen_at = ?
         WHERE user_id = ?`,
      )
      .run(seenAtUnix, userId);
  }

  public toggleIncludeReplies(
    userId: string,
    nowUnix: number,
  ): TrackedAccount | null {
    const result = this.db
      .prepare(
        `UPDATE tracked_accounts
         SET include_replies = CASE WHEN include_replies = 1 THEN 0 ELSE 1 END,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowUnix, userId);

    if (result.changes === 0) {
      return null;
    }
    return this.findByUserId(userId);
  }

  public toggleEnabled(userId: string, nowUnix: number): TrackedAccount | null {
    const result = this.db
      .prepare(
        `UPDATE tracked_accounts
         SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(nowUnix, userId);

    if (result.changes === 0) {
      return null;
    }
    return this.findByUserId(userId);
  }

  public deleteByUserId(userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM tracked_accounts WHERE user_id = ?')
      .run(userId);
    return result.changes > 0;
  }

  public deleteByHandle(handle: string): TrackedAccount | null {
    const existing = this.findByHandle(handle);
    if (existing === null) {
      return null;
    }
    const deleted = this.deleteByUserId(existing.userId);
    return deleted ? existing : null;
  }

  private mapRow(row: TrackedAccountRow): TrackedAccount {
    const availability: AccountAvailability =
      row.availability === 'unavailable' ? 'unavailable' : 'available';

    return {
      userId: row.user_id,
      handle: row.handle,
      displayName: row.display_name,
      bio: row.bio,
      websiteUrl: row.website_url,
      avatarUrl: row.avatar_url,
      bannerUrl: row.banner_url,
      includeReplies: row.include_replies === 1,
      enabled: row.enabled === 1,
      availability,
      unavailableReason: row.unavailable_reason,
      consecutiveMisses: row.consecutive_misses,
      baselineAt: row.baseline_at,
      lastTweetSeenAt: row.last_tweet_seen_at,
      lastProfileCheckedAt: row.last_profile_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
