import type Database from 'better-sqlite3';
import type { SyncStateRepository } from '../../application/ports/repositories.js';

export class SqliteSyncStateRepository implements SyncStateRepository {
  public constructor(private readonly db: Database.Database) {}

  public get(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(
        'SELECT value FROM sync_state WHERE key = ?',
      )
      .get(key);
    return row ? row.value : null;
  }

  public set(key: string, value: string, nowUnix: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, nowUnix);
  }
}
