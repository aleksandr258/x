# X (Twitter) NFT Account Monitor & Telegram Alert Service

Production-grade monitoring daemon for curated X (Twitter) NFT accounts (collections, founders, launchpads, alpha callers) that detects mints, allowlist/WL drops, EVM smart contracts (`0x...`), Web3 links, and `"было → стало"` profile changes in near real-time — delivering rich Russian-language alerts to authorized Telegram administrators.

---

## Key Features

- **Real-Time Tweet & Thread Activity Monitoring**:
  - Tracks original posts, quote tweets, retweets, and (optionally per account) replies.
  - Sliding overlap window (`lastPoll - 90s`) + SQLite `seen_tweets` primary-key deduplication + downtime lookback cap (`1800s`) guarantee **zero missed tweets** and **zero duplicate alerts**.
- **Actionable NFT Alpha Signal Extraction**:
  - Unicode word-boundary keyword matching (customizable English & Russian triggers via `/addkw` & `/delkw` without substring false positives like `wl` inside `bowl`).
  - Automatic `0x` EVM smart contract address extraction preserving EIP-55 checksum casing inside one-tap copyable `<code>0x...</code>` blocks.
  - Automatic `t.co` link unwrapping and categorization (`🚀 Минт/Лаунчпад`, `🎟 Раффл/Allowlist`, `🛒 Маркетплейс`, `💬 Discord`, `🌐 Сайт`).
- **Profile `"Было → Стало"` Diffing & Handle Rename Continuity**:
  - Tracks accounts by immutable numeric X `userId`.
  - Detects `@handle` rebrands/renames (`@old → @new`), `displayName`, `bio`, `websiteUrl`, `avatarUrl`, `bannerUrl`, and account suspension/availability changes — automatically updating the stored handle so search queries continue uninterrupted.
- **Free/Starter Tier Safe Rate Limiting (`TwitterAPI.io`)**:
  - Global serialized 2-lane priority pacer (`HIGH` for interactive `/add`, `NORMAL` for background polls) enforces `>= 5500ms` between requests (`0.181 QPS < 0.2 QPS` limit).
  - Dual-constraint search query batching (`<= 20` handles AND `<= 450` chars) and batch profile lookups (`<= 50` IDs/call).
  - **0 API requests / 0 credits** spent when 0 active accounts are tracked.
- **Strict Hexagonal Architecture (Ports & Adapters)**:
  - `src/domain/`: 100% pure TypeScript with zero external runtime dependencies.
  - `src/application/`: Pure use-case orchestrators and explicit port interfaces.
  - `src/infrastructure/`: `TwitterApiIoProvider`, `MockTwitterProvider`, `better-sqlite3` (`WAL` mode), and `grammY` Telegram adapter (with flood-control `429` retry transformer and tag-safe `<= 4096` HTML clamping).

---

## Architecture Overview

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the complete architectural specification, sequence diagrams, database schema, and rate-limit budget analysis.

```text
src/
├── index.ts                          # Process entrypoint & SIGINT/SIGTERM handlers
├── bootstrap.ts                      # Composition Root (Dependency Injection wiring)
├── config/env.ts                     # Zod-validated environment configuration
├── domain/                           # Pure entities & business rules (0 external deps)
├── application/                      # Ports (interfaces) & use-case services
└── infrastructure/                   # TwitterAPI.io, Mock, SQLite WAL, grammY adapters
```

---

## Prerequisites

- **Node.js `>= 22.0.0`** (or **Docker** with Docker Compose)
- **Telegram Bot Token** from [`@BotFather`](https://t.me/BotFather)
- **Your Telegram Chat ID** (numeric user ID or admin group ID; e.g. via `@userinfobot` — or start the bot once and check the warning log for `Unauthorized Telegram access attempt blocked` which prints your `chatId`)
- **`TwitterAPI.io` API Key** from [twitterapi.io](https://twitterapi.io) *(optional for local testing — `MOCK_MODE=true` works without any X API key!)*

---

## Quickstart 1: Local Development in `MOCK_MODE` (No X API Key Needed)

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create `.env` from `.env.example`**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set:
   ```dotenv
   TELEGRAM_BOT_TOKEN=1234567890:YOUR_TELEGRAM_BOT_TOKEN
   ADMIN_CHAT_IDS=123456789
   MOCK_MODE=true
   MOCK_AUTO_EVENTS=true
   LOG_PRETTY=true
   ```

3. **Start in watch mode**:
   ```bash
   npm run dev
   ```

4. **Test in Telegram**:
   - Send `/start` to your bot.
   - Send `@azuki` or `/add https://x.com/boredapeyc`.
   - Send `/test_alert` to immediately preview both a `HIGH`-priority NFT Mint alert (with `0x` contract copy block & Web3 links) and a `"было → стало"` profile change alert.
   - Send `/list` to toggle replies (`💬`), pause/resume (`⏸/▶️`), or delete (`🗑`).
   - Send `/status` and tap **`[🔄 Проверить сейчас]`**.

---

## Quickstart 2: Live Production Mode (`TwitterAPI.io`)

1. Configure `.env`:
   ```dotenv
   TELEGRAM_BOT_TOKEN=1234567890:YOUR_TELEGRAM_BOT_TOKEN
   ADMIN_CHAT_IDS=123456789
   MOCK_MODE=false
   TWITTER_API_KEY=your_twitterapi_io_key
   TWITTER_MIN_INTERVAL_MS=5500
   TWEET_POLL_INTERVAL_SEC=60
   PROFILE_POLL_INTERVAL_SEC=180
   ```

2. **Build and run natively**:
   ```bash
   npm run build
   npm start
   ```

### Or Deploy with Docker Compose (Recommended for 24/7 VPS)

```bash
mkdir -p data
docker compose up -d --build
docker compose logs -f
```

SQLite WAL database files are persisted in `./data/monitor.db` on the host volume. Graceful `SIGTERM` on `docker compose down` / `restart` aborts sleeping pollers, stops Telegram long-polling, and cleanly checkpoints SQLite WAL.

---

## Telegram Bot Commands (Russian UX)

| Command / Input | Description |
|---|---|
| `/start`, `/help` | Приветствие, текущий режим (`LIVE` / `MOCK`) и справка по командам |
| `/add <@handle \| url>` | Добавить X-аккаунт в мониторинг (`@azuki`, `azuki`, `https://x.com/azuki`) |
| `@handle` или `https://x.com/...` | Быстрое добавление аккаунта отправкой юзернейма или ссылки без команды |
| `/list` | Постраничный список отслеживаемых аккаунтов с inline-кнопками (`💬`, `⏸/▶️`, `🗑`) |
| `/remove <@handle \| url>` | Удалить аккаунт из мониторинга |
| `/keywords` | Показать активные ключевые слова NFT-триггеров |
| `/addkw <слово1, слово2>` | Добавить одно или несколько ключевых слов (поддерживаются RU и EN) |
| `/delkw <слово>` | Удалить ключевое слово |
| `/status` | Аптайм, счётчики аккаунтов, статистика API/лимитов и кнопка `[🔄 Проверить сейчас]` |
| `/test_alert` | Отправить симуляцию NFT-минт алерта + алерта изменения профиля |

---

## Rate-Limit & Request Math (`TwitterAPI.io`)

- **Starter / Unpaid Rate Limit**: `0.2 QPS` (`1` request per `5,000 ms`).
- **Configured Pacer**: `TWITTER_MIN_INTERVAL_MS=5500` (`0.181 QPS`), serialized across a 2-lane priority queue (`HIGH` interactive `/add` requests jump ahead of `NORMAL` background batch polls without violating the 5.5s spacing).
- **20 Tracked Accounts Example**:
  - Tweet search (`TWEET_POLL_INTERVAL_SEC=60`): 20 handles fit in **1** query (`~260` chars `<= 450`) = `60` req/hr.
  - Profile batch (`PROFILE_POLL_INTERVAL_SEC=180`): 20 IDs fit in **1** `batch_info_by_ids` call = `20` req/hr.
  - Total steady-state load: **80 requests/hour** (`~0.022 QPS` average), leaving >85% rate-limit headroom.

---

## Development & Verification Scripts

```bash
npm run typecheck   # Strict TypeScript check across src/ and tests/
npm run build       # Compile production ESM build to dist/
npm test            # Run full Vitest unit & integration suite
```
