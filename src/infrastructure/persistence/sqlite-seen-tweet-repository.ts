import type Database from 'better-sqlite3';
import type {
  SeenTweetRecord,
  SeenTweetRepository,
} from '../../application/ports/repositories.js';

const SQLITE_CHUNK_SIZE = 500;

export class SqliteSeenTweetRepository implements SeenTweetRepository {
  public constructor(private readonly db: Database.Database) {}

  public filterUnseenIds(tweetIds: readonly string[]): Set<string> {
    if (tweetIds.length === 0) {
      return new Set<string>();
    }

    const uniqueIds = Array.from(new Set(tweetIds));
    const alreadySeen = new Set<string>();

    for (let i = 0; i < uniqueIds.length; i += SQLITE_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare<string[], { tweet_id: string }>(
          `SELECT tweet_id FROM seen_tweets WHERE tweet_id IN (${placeholders})`,
        )
        .all(...chunk);

      for (const row of rows) {
        alreadySeen.add(row.tweet_id);
      }
    }

    const unseen = new Set<string>();
    for (const id of uniqueIds) {
      if (!alreadySeen.has(id)) {
        unseen.add(id);
      }
    }
    return unseen;
  }

  public markSeen(record: SeenTweetRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_tweets (tweet_id, author_id, created_at_unix, seen_at_unix)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        record.tweetId,
        record.authorId,
        record.createdAtUnix,
        record.seenAtUnix,
      );
  }

  public markSeenBatch(records: readonly SeenTweetRecord[]): void {
    if (records.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO seen_tweets (tweet_id, author_id, created_at_unix, seen_at_unix)
       VALUES (?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((items: readonly SeenTweetRecord[]) => {
      for (const item of items) {
        stmt.run(
          item.tweetId,
          item.authorId,
          item.createdAtUnix,
          item.seenAtUnix,
        );
      }
    });

    tx(records);
  }

  public pruneOlderThan(cutoffUnix: number): number {
    const result = this.db
      .prepare('DELETE FROM seen_tweets WHERE seen_at_unix < ?')
      .run(cutoffUnix);
    return result.changes;
  }

  public count(): number {
    const row = this.db
      .prepare<[], { cnt: number }>('SELECT COUNT(*) AS cnt FROM seen_tweets')
      .get();
    return row?.cnt ?? 0;
  }
}
