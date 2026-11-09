import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseMaintainer } from '../../application/ports/repositories.js';
import { runMigrations } from './migrations.js';

export class SqliteDatabase implements DatabaseMaintainer {
  public readonly connection: Database.Database;

  public constructor(dbPath: string) {
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }

    this.connection = new Database(dbPath);
    this.configurePragmas();
    runMigrations(this.connection);
  }

  public optimize(): void {
    this.connection.pragma('optimize');
    try {
      this.connection.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore if running in :memory: mode or checkpoint is busy
    }
  }

  public close(): void {
    if (this.connection.open) {
      this.connection.close();
    }
  }

  private configurePragmas(): void {
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('synchronous = NORMAL');
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma('busy_timeout = 5000');
    this.connection.pragma('temp_store = MEMORY');
  }
}
