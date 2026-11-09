import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS tracked_accounts (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        website_url TEXT,
        avatar_url TEXT,
        banner_url TEXT,
        include_replies INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        availability TEXT NOT NULL DEFAULT 'available',
        unavailable_reason TEXT,
        consecutive_misses INTEGER NOT NULL DEFAULT 0,
        baseline_at INTEGER NOT NULL,
        last_tweet_seen_at INTEGER,
        last_profile_checked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tracked_accounts_handle
        ON tracked_accounts(handle COLLATE NOCASE);

      CREATE INDEX IF NOT EXISTS idx_tracked_accounts_enabled
        ON tracked_accounts(enabled);

      CREATE TABLE IF NOT EXISTS seen_tweets (
        tweet_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        created_at_unix INTEGER NOT NULL,
        seen_at_unix INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_seen_tweets_seen_at
        ON seen_tweets(seen_at_unix);

      CREATE TABLE IF NOT EXISTS trigger_keywords (
        keyword TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '002_unique_account_handle',
    sql: `
      UPDATE tracked_accounts
      SET handle = handle || '#' || user_id
      WHERE user_id IN (
        SELECT user_id FROM (
          SELECT
            user_id,
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(handle)
              ORDER BY enabled DESC, updated_at DESC, rowid DESC
            ) AS rn
          FROM tracked_accounts
        )
        WHERE rn > 1
      );

      DROP INDEX IF EXISTS idx_tracked_accounts_handle;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_accounts_handle_unique
        ON tracked_accounts(handle COLLATE NOCASE);
    `,
  },
];

export function runMigrations(
  db: Database.Database,
  nowUnix: number = Math.floor(Date.now() / 1000),
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db
    .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
    .all();
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const insertVersion = db.prepare<[number, number]>(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyTx = db.transaction(() => {
      db.exec(migration.sql);
      insertVersion.run(migration.version, nowUnix);
    });

    applyTx();
  }
}
