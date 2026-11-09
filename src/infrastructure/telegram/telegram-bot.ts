import {
  Bot,
  GrammyError,
  InlineKeyboard,
  type Context,
} from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Clock } from '../../application/ports/clock.js';
import type { Logger } from '../../application/ports/logger.js';
import type { PaginatedAccounts } from '../../application/ports/repositories.js';
import type { AccountManagementService } from '../../application/services/account-management-service.js';
import type { KeywordManagementService } from '../../application/services/keyword-management-service.js';
import type { MonitorCoordinator } from '../../application/services/monitor-coordinator.js';
import type { TestAlertService } from '../../application/services/test-alert-service.js';
import type { TrackedAccount } from '../../domain/entities/account.js';
import { HandleParser } from '../../domain/services/handle-parser.js';
import {
  clampPlainText,
  escapeAndClampHtml,
  escapeHtml,
} from './html-escape.js';
import { createTelegramRetryTransformer } from './retry-transformer.js';
import { TelegramFormatter } from './telegram-formatter.js';

const MAX_CALLBACK_BYTES = 64;
const DEFAULT_LIST_PAGE_SIZE = 6;
const TELEGRAM_HTTP_TIMEOUT_SECONDS = 45;
const MAX_COMPACT_USER_TOKENS = 256;
const POLLING_RESTART_BASE_MS = 3_000;
const POLLING_RESTART_MAX_MS = 30_000;
const POLLING_AUTH_ERROR_BACKOFF_MS = 60_000;

export interface TelegramBotDependencies {
  readonly token: string;
  readonly adminChatIds: readonly string[];
  readonly mode: 'LIVE' | 'MOCK';
  readonly accountService: AccountManagementService;
  readonly keywordService: KeywordManagementService;
  readonly coordinator: MonitorCoordinator;
  readonly testAlertService: TestAlertService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly botInfo?: UserFromGetMe;
}

export class TelegramBotAdapter {
  public readonly bot: Bot;
  private readonly adminSet: ReadonlySet<string>;
  private pollingPromise: Promise<void> | null = null;
  private lifecycleController: AbortController = new AbortController();

  private readonly tokenToUserId = new Map<string, string>();
  private readonly userIdToToken = new Map<string, string>();
  private compactTokenSeq = 0;

  public constructor(private readonly deps: TelegramBotDependencies) {
    this.bot = new Bot(deps.token, {
      client: {
        timeoutSeconds: TELEGRAM_HTTP_TIMEOUT_SECONDS,
      },
      ...(deps.botInfo ? { botInfo: deps.botInfo } : {}),
    });
    this.adminSet = new Set(deps.adminChatIds.map((id) => id.trim()));

    this.bot.api.config.use(
      createTelegramRetryTransformer(deps.clock, deps.logger),
    );

    this.registerErrorHandler();
    this.registerAuthMiddleware();
    this.registerCommands();
    this.registerCallbackQueries();
    this.registerPlainTextHandler();
  }

  public async startPolling(): Promise<void> {
    if (this.pollingPromise !== null) {
      return;
    }

    this.lifecycleController = new AbortController();
    const signal = this.lifecycleController.signal;

    try {
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Справка и начало работы' },
        { command: 'add', description: 'Добавить аккаунт (@handle или ссылка)' },
        { command: 'list', description: 'Список отслеживаемых аккаунтов' },
        { command: 'remove', description: 'Удалить аккаунт из мониторинга' },
        { command: 'keywords', description: 'Список ключевых слов NFT' },
        { command: 'addkw', description: 'Добавить ключевые слова' },
        { command: 'delkw', description: 'Удалить ключевое слово' },
        { command: 'status', description: 'Статус сервиса и ручная проверка' },
        { command: 'test_alert', description: 'Отправить тестовый алерт' },
      ]);
    } catch (err) {
      this.deps.logger.warn('Could not register Telegram command menu', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.pollingPromise = this.runSupervisedPollingLoop(signal);
  }

  public async stopPolling(): Promise<void> {
    this.lifecycleController.abort();

    try {
      await this.bot.stop();
    } catch (err) {
      this.deps.logger.warn('Non-fatal warning while stopping Telegram long-polling', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.pollingPromise !== null) {
      await Promise.allSettled([this.pollingPromise]);
      this.pollingPromise = null;
    }

    this.deps.logger.info('Telegram bot long-polling stopped');
  }

  private async runSupervisedPollingLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        await this.bot.start({
          drop_pending_updates: false,
          onStart: (botInfo) => {
            consecutiveFailures = 0;
            this.deps.logger.info('Telegram bot long-polling started', {
              botUsername: botInfo.username,
              botId: botInfo.id,
            });
          },
        });

        // bot.start() resolved cleanly (via bot.stop())
        if (signal.aborted) {
          break;
        }
        break;
      } catch (err) {
        if (signal.aborted) {
          break;
        }

        consecutiveFailures += 1;
        const isAuthErr =
          err instanceof GrammyError &&
          (err.error_code === 401 || err.error_code === 404);
        const backoffMs = isAuthErr
          ? POLLING_AUTH_ERROR_BACKOFF_MS
          : Math.min(
              POLLING_RESTART_MAX_MS,
              POLLING_RESTART_BASE_MS * Math.pow(2, consecutiveFailures - 1),
            );

        this.deps.logger.error(
          'Telegram long-polling interrupted; scheduling supervised restart',
          {
            consecutiveFailures,
            backoffMs,
            error: err instanceof Error ? err.message : String(err),
          },
        );

        try {
          if (this.bot.isRunning()) {
            await this.bot.stop();
          }
        } catch {
          // Ignore cleanup errors before retry sleep
        }

        await this.deps.clock.sleep(backoffMs, signal);
      }
    }
  }

  private registerErrorHandler(): void {
    this.bot.catch((botErr) => {
      this.deps.logger.error('Unhandled Telegram bot update error', {
        chatId: botErr.ctx.chat?.id,
        error:
          botErr.error instanceof Error
            ? botErr.error.message
            : String(botErr.error),
      });
    });
  }

  private registerAuthMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : null;
      if (chatId !== null && this.adminSet.has(chatId)) {
        await next();
        return;
      }

      this.deps.logger.warn('Unauthorized Telegram access attempt blocked', {
        chatId,
        userId: ctx.from?.id,
        username: ctx.from?.username,
      });

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
          text: '⛔ Доступ запрещён.',
          show_alert: true,
        });
      } else if (ctx.chat) {
        await ctx.reply('⛔ Доступ запрещён.');
      }
    });
  }

  private registerCommands(): void {
    const sendWelcome = async (ctx: Context): Promise<void> => {
      await ctx.reply(
        TelegramFormatter.formatWelcomeMessage(this.deps.mode),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
      );
    };

    this.bot.command('start', sendWelcome);
    this.bot.command('help', sendWelcome);

    this.bot.command('add', async (ctx) => {
      const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
      await this.handleAddFlow(ctx, arg);
    });

    this.bot.command('remove', async (ctx) => {
      const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
      if (arg.length === 0) {
        await ctx.reply(
          '⚠️ Укажите аккаунт для удаления.\nПример: <code>/remove @boredapeyc</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const result = this.deps.accountService.removeAccountByInput(arg);
      if (result.status === 'INVALID_INPUT') {
        await ctx.reply(
          TelegramFormatter.formatInvalidHandleError(result.reason),
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (result.status === 'NOT_FOUND') {
        await ctx.reply(
          `ℹ️ Аккаунт <code>@${escapeHtml(result.handle)}</code> не найден в списке отслеживаемых.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await ctx.reply(
        `🗑 Аккаунт <b>@${escapeHtml(result.account.handle)}</b> удалён из отслеживания.`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('list', async (ctx) => {
      const paginated = this.deps.accountService.listPaginated(
        1,
        DEFAULT_LIST_PAGE_SIZE,
      );
      await ctx.reply(TelegramFormatter.formatAccountsList(paginated), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: this.buildAccountsListKeyboard(paginated),
      });
    });

    this.bot.command('keywords', async (ctx) => {
      const keywords = this.deps.keywordService.listKeywords();
      await ctx.reply(TelegramFormatter.formatKeywordsList(keywords), {
        parse_mode: 'HTML',
      });
    });

    this.bot.command('addkw', async (ctx) => {
      const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
      if (arg.length === 0) {
        await ctx.reply(
          '⚠️ Укажите одно или несколько ключевых слов через запятую.\nПример: <code>/addkw mint, free claim, минт</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const res = this.deps.keywordService.addKeywordsFromInput(arg);
      if (res.normalizedKeywords.length === 0) {
        await ctx.reply('⚠️ Не удалось распознать валидные ключевые слова.');
        return;
      }

      const formatted = res.normalizedKeywords
        .slice(0, 40)
        .map((k) => `<code>${escapeAndClampHtml(k, 40)}</code>`)
        .join(', ');

      await ctx.reply(
        `✅ Обработано: ${formatted}\nНовых слов добавлено: <b>${res.addedCount}</b> (всего активных: <b>${res.totalKeywords}</b>).`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('delkw', async (ctx) => {
      const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
      if (arg.length === 0) {
        await ctx.reply(
          '⚠️ Укажите ключевое слово для удаления.\nПример: <code>/delkw live</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const res = this.deps.keywordService.removeKeywordFromInput(arg);
      if (!res.removed) {
        await ctx.reply(
          `ℹ️ Слово <code>${escapeAndClampHtml(res.keyword, 40)}</code> не найдено в списке триггеров.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await ctx.reply(
        `🗑 Триггер <code>${escapeAndClampHtml(res.keyword, 40)}</code> удалён (осталось: <b>${res.totalKeywords}</b>).`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('status', async (ctx) => {
      const snapshot = this.deps.coordinator.getStatusSnapshot();
      await ctx.reply(TelegramFormatter.formatStatusReport(snapshot), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: this.buildStatusKeyboard(),
      });
    });

    this.bot.command('test_alert', async (ctx) => {
      try {
        await this.deps.testAlertService.sendSimulatedAlerts();
        await ctx.reply(
          '✅ Тестовые уведомления (NFT минт + изменение профиля) отправлены.',
        );
      } catch (err) {
        await ctx.reply(
          `❌ Не удалось отправить тестовый алерт: <code>${escapeAndClampHtml(err instanceof Error ? err.message : String(err), 200)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
    });
  }

  private registerCallbackQueries(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      if (data === 'chk_now') {
        await ctx.answerCallbackQuery({
          text: '🔄 Запускаем внеплановую проверку…',
        });

        try {
          const checkResult = await this.deps.coordinator.runImmediateCheck(
            this.lifecycleController.signal,
          );
          const refreshedStatus = this.deps.coordinator.getStatusSnapshot();
          await this.safeEditMessageText(
            ctx,
            TelegramFormatter.formatStatusReport(refreshedStatus),
            this.buildStatusKeyboard(),
          );
          await ctx.reply(
            TelegramFormatter.formatImmediateCheckSummary(checkResult),
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          if (this.lifecycleController.signal.aborted) {
            return;
          }
          await ctx.reply(
            `❌ Ошибка при проверке: <code>${escapeAndClampHtml(err instanceof Error ? err.message : String(err), 220)}</code>`,
            { parse_mode: 'HTML' },
          );
        }
        return;
      }

      if (data.startsWith('l:')) {
        const pageNum = Number.parseInt(data.slice(2), 10);
        const safePage = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1;
        const paginated = this.deps.accountService.listPaginated(
          safePage,
          DEFAULT_LIST_PAGE_SIZE,
        );
        await ctx.answerCallbackQuery();
        await this.safeEditMessageText(
          ctx,
          TelegramFormatter.formatAccountsList(paginated),
          this.buildAccountsListKeyboard(paginated),
        );
        return;
      }

      const parsedAction = this.decodeAccountActionCallback(data);
      if (!parsedAction) {
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
        return;
      }

      const { action, userId, targetContext } = parsedAction;

      if (action === 'r') {
        const updated = this.deps.accountService.toggleIncludeReplies(userId);
        if (!updated) {
          await ctx.answerCallbackQuery({
            text: 'Аккаунт уже удалён',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({
          text: `Ответы (replies) для @${clampPlainText(updated.handle, 24)}: ${updated.includeReplies ? 'ВКЛ' : 'ВЫКЛ'}`,
        });
        await this.refreshAccountOrListView(ctx, updated, targetContext);
        return;
      }

      if (action === 'p') {
        const updated = this.deps.accountService.toggleEnabled(userId);
        if (!updated) {
          await ctx.answerCallbackQuery({
            text: 'Аккаунт уже удалён',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({
          text: updated.enabled
            ? `▶️ Мониторинг @${clampPlainText(updated.handle, 24)} возобновлён`
            : `⏸ Мониторинг @${clampPlainText(updated.handle, 24)} поставлен на паузу`,
        });
        await this.refreshAccountOrListView(ctx, updated, targetContext);
        return;
      }

      if (action === 'd') {
        const removed = this.deps.accountService.removeAccountByUserId(userId);
        if (!removed) {
          await ctx.answerCallbackQuery({
            text: 'Аккаунт уже удалён',
            show_alert: true,
          });
        } else {
          await ctx.answerCallbackQuery({
            text: `🗑 @${clampPlainText(removed.handle, 24)} удалён`,
          });
        }

        if (targetContext === 'c') {
          const handleLabel = removed
            ? `@${escapeAndClampHtml(removed.handle, 32)}`
            : `ID ${escapeAndClampHtml(userId, 32)}`;
          await this.safeEditMessageText(
            ctx,
            `🗑 Аккаунт <b>${handleLabel}</b> удалён из отслеживания.`,
          );
        } else {
          const page = Number.parseInt(targetContext, 10) || 1;
          const paginated = this.deps.accountService.listPaginated(
            page,
            DEFAULT_LIST_PAGE_SIZE,
          );
          await this.safeEditMessageText(
            ctx,
            TelegramFormatter.formatAccountsList(paginated),
            this.buildAccountsListKeyboard(paginated),
          );
        }
      }
    });
  }

  private registerPlainTextHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      const directParse = HandleParser.parseDirectMessageInput(text);
      if (directParse === null) {
        return;
      }
      await this.handleAddFlow(ctx, text);
    });
  }

  private async handleAddFlow(ctx: Context, rawInput: string): Promise<void> {
    if (rawInput.trim().length === 0) {
      await ctx.reply(TelegramFormatter.formatInvalidHandleError('EMPTY'), {
        parse_mode: 'HTML',
      });
      return;
    }

    const parsedPreview = HandleParser.parse(rawInput);
    if (!parsedPreview.ok) {
      await ctx.reply(
        TelegramFormatter.formatInvalidHandleError(parsedPreview.reason),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const pendingMsg = await ctx.reply(
      `⏳ Проверяю профиль <code>@${escapeHtml(parsedPreview.handle)}</code> в X…`,
      { parse_mode: 'HTML' },
    );

    try {
      const result = await this.deps.accountService.addAccount(
        rawInput,
        this.lifecycleController.signal,
      );

      if (result.status === 'INVALID_INPUT') {
        await ctx.api.editMessageText(
          pendingMsg.chat.id,
          pendingMsg.message_id,
          TelegramFormatter.formatInvalidHandleError(result.reason),
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (result.status === 'NOT_FOUND') {
        await ctx.api.editMessageText(
          pendingMsg.chat.id,
          pendingMsg.message_id,
          `❌ Профиль <code>@${escapeHtml(result.handle)}</code> не найден в X (или недоступен).`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const header =
        result.status === 'ADDED'
          ? '✅ <b>Аккаунт добавлен в мониторинг!</b>'
          : 'ℹ️ <b>Этот аккаунт уже отслеживается:</b>';

      await ctx.api.editMessageText(
        pendingMsg.chat.id,
        pendingMsg.message_id,
        TelegramFormatter.formatAccountCard(
          result.account,
          header,
          result.status === 'ALREADY_TRACKED'
            ? result.previousHandle
            : undefined,
        ),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: this.buildSingleAccountCardKeyboard(result.account),
        },
      );
    } catch (err) {
      if (this.lifecycleController.signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        pendingMsg.chat.id,
        pendingMsg.message_id,
        `❌ Ошибка при запросе к X API: <code>${escapeAndClampHtml(message, 250)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  }

  private async refreshAccountOrListView(
    ctx: Context,
    updated: TrackedAccount,
    targetContext: string,
  ): Promise<void> {
    if (targetContext === 'c') {
      await this.safeEditMessageText(
        ctx,
        TelegramFormatter.formatAccountCard(
          updated,
          '⚙️ <b>Настройки отслеживаемого аккаунта</b>',
        ),
        this.buildSingleAccountCardKeyboard(updated),
      );
      return;
    }

    const page = Number.parseInt(targetContext, 10) || 1;
    const paginated = this.deps.accountService.listPaginated(
      page,
      DEFAULT_LIST_PAGE_SIZE,
    );
    await this.safeEditMessageText(
      ctx,
      TelegramFormatter.formatAccountsList(paginated),
      this.buildAccountsListKeyboard(paginated),
    );
  }

  private buildSingleAccountCardKeyboard(
    account: TrackedAccount,
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    const repliesLabel = account.includeReplies
      ? '💬 Ответы: ВКЛ'
      : '💬 Ответы: ВЫКЛ';
    const pauseLabel = account.enabled ? '⏸ Пауза' : '▶️ Включить';

    kb.text(
      repliesLabel,
      this.encodeAccountActionCallback('r', account.userId, 'c'),
    )
      .text(
        pauseLabel,
        this.encodeAccountActionCallback('p', account.userId, 'c'),
      )
      .row()
      .text(
        '🗑 Удалить',
        this.encodeAccountActionCallback('d', account.userId, 'c'),
      );

    return kb;
  }

  private buildAccountsListKeyboard(
    paginated: PaginatedAccounts,
  ): InlineKeyboard | undefined {
    if (paginated.total === 0) {
      return undefined;
    }

    const kb = new InlineKeyboard();
    const p = String(paginated.page);

    for (const acc of paginated.items) {
      const shortHandle = clampPlainText(acc.handle, 11);
      const rIcon = acc.includeReplies ? '💬✓' : '💬✗';
      const pIcon = acc.enabled ? '⏸' : '▶️';

      kb.text(
        `@${shortHandle} ${rIcon}`,
        this.encodeAccountActionCallback('r', acc.userId, p),
      )
        .text(pIcon, this.encodeAccountActionCallback('p', acc.userId, p))
        .text('🗑', this.encodeAccountActionCallback('d', acc.userId, p))
        .row();
    }

    if (paginated.totalPages > 1) {
      if (paginated.page > 1) {
        kb.text(
          '⬅️ Назад',
          encodeCallbackData(`l:${paginated.page - 1}`),
        );
      }
      kb.text(
        `${paginated.page}/${paginated.totalPages}`,
        encodeCallbackData(`l:${paginated.page}`),
      );
      if (paginated.page < paginated.totalPages) {
        kb.text(
          'Вперёд ➡️',
          encodeCallbackData(`l:${paginated.page + 1}`),
        );
      }
    }

    return kb;
  }

  private buildStatusKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text(
      '🔄 Проверить сейчас',
      encodeCallbackData('chk_now'),
    );
  }

  private encodeAccountActionCallback(
    action: 'r' | 'p' | 'd',
    userId: string,
    targetContext: string,
  ): string {
    const safeCtx = targetContext.slice(0, 8);
    const direct = `${action}:${userId}:${safeCtx}`;
    if (
      !userId.includes(':') &&
      !userId.startsWith('~') &&
      Buffer.byteLength(direct, 'utf8') <= MAX_CALLBACK_BYTES
    ) {
      return encodeCallbackData(direct);
    }

    const compactToken = this.getOrCreateCompactUserToken(userId);
    return encodeCallbackData(`${action}:${compactToken}:${safeCtx}`);
  }

  private decodeAccountActionCallback(data: string): {
    readonly action: 'r' | 'p' | 'd';
    readonly userId: string;
    readonly targetContext: string;
  } | null {
    const firstColon = data.indexOf(':');
    const lastColon = data.lastIndexOf(':');
    if (firstColon <= 0 || lastColon <= firstColon) {
      return null;
    }

    const action = data.slice(0, firstColon);
    if (action !== 'r' && action !== 'p' && action !== 'd') {
      return null;
    }

    const rawIdOrToken = data.slice(firstColon + 1, lastColon);
    const targetContext = data.slice(lastColon + 1) || '1';
    if (rawIdOrToken.length === 0) {
      return null;
    }

    const resolvedUserId = rawIdOrToken.startsWith('~')
      ? this.tokenToUserId.get(rawIdOrToken) ?? null
      : rawIdOrToken;

    if (!resolvedUserId) {
      return null;
    }

    return {
      action,
      userId: resolvedUserId,
      targetContext,
    };
  }

  private getOrCreateCompactUserToken(userId: string): string {
    const existing = this.userIdToToken.get(userId);
    if (existing !== undefined) {
      return existing;
    }

    this.compactTokenSeq = (this.compactTokenSeq + 1) % 1_000_000;
    const token = `~${this.compactTokenSeq.toString(36)}`;

    if (this.tokenToUserId.size >= MAX_COMPACT_USER_TOKENS) {
      const oldestToken = this.tokenToUserId.keys().next().value;
      if (oldestToken !== undefined) {
        const evictedUserId = this.tokenToUserId.get(oldestToken);
        this.tokenToUserId.delete(oldestToken);
        if (evictedUserId !== undefined) {
          this.userIdToToken.delete(evictedUserId);
        }
      }
    }

    this.tokenToUserId.set(token, userId);
    this.userIdToToken.set(userId, token);
    return token;
  }

  private async safeEditMessageText(
    ctx: Context,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      await ctx.editMessageText(html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore harmless "message is not modified" error from Telegram
      if (!msg.toLowerCase().includes('message is not modified')) {
        this.deps.logger.warn('Failed to edit Telegram message', {
          error: msg,
        });
      }
    }
  }
}

export function encodeCallbackData(data: string): string {
  const byteLength = Buffer.byteLength(data, 'utf8');
  if (byteLength > MAX_CALLBACK_BYTES) {
    throw new Error(
      `Telegram callback_data exceeds 64 bytes (${byteLength} bytes): ${data}`,
    );
  }
  return data;
}
