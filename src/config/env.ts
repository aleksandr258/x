import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim().length === 0) {
        return defaultValue;
      }
      const normalized = raw.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
      }
      throw new Error(`Invalid boolean value "${raw}"`);
    });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim().length === 0) {
        return defaultValue;
      }
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid integer "${raw}"`);
      }
      return parsed;
    })
    .pipe(z.number().int().min(min).max(max));

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z
      .string()
      .trim()
      .min(1, 'TELEGRAM_BOT_TOKEN is required'),
    ADMIN_CHAT_IDS: z
      .string()
      .trim()
      .min(1, 'ADMIN_CHAT_IDS is required (comma-separated chat IDs)')
      .transform((val) =>
        Array.from(
          new Set(
            val
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        ),
      )
      .refine(
        (ids) => ids.length > 0 && ids.every((id) => /^-?\d+$/.test(id)),
        'ADMIN_CHAT_IDS must contain valid numeric Telegram chat IDs separated by commas',
      ),
    MOCK_MODE: booleanFromEnv(false),
    MOCK_AUTO_EVENTS: booleanFromEnv(false),
    TWITTER_API_KEY: z.string().trim().optional().default(''),
    TWITTER_API_BASE_URL: z
      .string()
      .trim()
      .url()
      .optional()
      .default('https://api.twitterapi.io'),
    TWITTER_HTTP_TIMEOUT_MS: intFromEnv(15_000, 1_000, 120_000),
    TWITTER_MIN_INTERVAL_MS: intFromEnv(5_500, 0, 60_000),
    TWITTER_MAX_RETRIES: intFromEnv(3, 0, 10),
    TWEET_POLL_INTERVAL_SEC: intFromEnv(60, 15, 86_400),
    PROFILE_POLL_INTERVAL_SEC: intFromEnv(180, 30, 86_400),
    TWEET_OVERLAP_BUFFER_SEC: intFromEnv(90, 0, 600),
    COLD_START_LOOKBACK_SEC: intFromEnv(300, 30, 3_600),
    MAX_LOOKBACK_SEC: intFromEnv(1_800, 60, 86_400),
    MAX_HANDLES_PER_SEARCH_BATCH: intFromEnv(20, 1, 50),
    MAX_SEARCH_QUERY_LENGTH: intFromEnv(450, 100, 500),
    MAX_PAGES_PER_SEARCH_BATCH: intFromEnv(3, 1, 20),
    MAX_USERS_PER_PROFILE_BATCH: intFromEnv(50, 1, 100),
    SQLITE_DB_PATH: z.string().trim().min(1).optional().default('./data/monitor.db'),
    SEEN_TWEETS_RETENTION_DAYS: intFromEnv(7, 1, 365),
    MAINTENANCE_INTERVAL_SEC: intFromEnv(3_600, 60, 86_400),
    LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error'])
      .optional()
      .default('info'),
    LOG_PRETTY: booleanFromEnv(false),
  })
  .superRefine((data, ctx) => {
    if (!data.MOCK_MODE && data.TWITTER_API_KEY.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TWITTER_API_KEY'],
        message:
          'TWITTER_API_KEY is required when MOCK_MODE=false (or set MOCK_MODE=true for local mock mode)',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadAppConfig(
  rawEnv: Record<string, string | undefined> = process.env,
): AppConfig {
  const normalizedEnv: Record<string, string | undefined> = {
    ...rawEnv,
    SQLITE_DB_PATH:
      rawEnv['SQLITE_DB_PATH'] && rawEnv['SQLITE_DB_PATH'].trim().length > 0
        ? rawEnv['SQLITE_DB_PATH']
        : rawEnv['DATABASE_PATH'],
  };
  const result = envSchema.safeParse(normalizedEnv);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return result.data;
}
