import type Database from 'better-sqlite3';
import type { KeywordRepository } from '../../application/ports/repositories.js';

export class SqliteKeywordRepository implements KeywordRepository {
  public constructor(private readonly db: Database.Database) {}

  public listAll(): string[] {
    const rows = this.db
      .prepare<[], { keyword: string }>(
        'SELECT keyword FROM trigger_keywords ORDER BY keyword ASC',
      )
      .all();
    return rows.map((r) => r.keyword);
  }

  public addMany(keywords: readonly string[], nowUnix: number): number {
    if (keywords.length === 0) {
      return 0;
    }

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO trigger_keywords (keyword, created_at) VALUES (?, ?)',
    );

    const tx = this.db.transaction((items: readonly string[]): number => {
      let inserted = 0;
      for (const raw of items) {
        const normalized = raw.trim().toLowerCase();
        if (normalized.length === 0) {
          continue;
        }
        const res = stmt.run(normalized, nowUnix);
        inserted += res.changes;
      }
      return inserted;
    });

    return tx(keywords);
  }

  public remove(keyword: string): boolean {
    const normalized = keyword.trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }
    const res = this.db
      .prepare('DELETE FROM trigger_keywords WHERE keyword = ?')
      .run(normalized);
    return res.changes > 0;
  }

  public count(): number {
    const row = this.db
      .prepare<[], { cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM trigger_keywords',
      )
      .get();
    return row?.cnt ?? 0;
  }
}
