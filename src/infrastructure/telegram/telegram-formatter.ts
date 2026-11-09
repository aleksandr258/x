import type { PaginatedAccounts } from '../../application/ports/repositories.js';
import type {
  ImmediateCheckResult,
  MonitorStatusSnapshot,
} from '../../application/services/monitor-coordinator.js';
import type { TrackedAccount } from '../../domain/entities/account.js';
import type {
  ProfileAlertEvent,
  SystemAlertEvent,
  TweetAlertEvent,
} from '../../domain/entities/alerts.js';
import type {
  ProfileChangedField,
  ProfileFieldChange,
} from '../../domain/entities/profile-diff.js';
import type {
  CategorizedLink,
  NftSignalAnalysis,
  Web3LinkCategory,
} from '../../domain/entities/signal.js';
import type { TweetKind } from '../../domain/entities/tweet.js';
import type { HandleParseErrorReason } from '../../domain/services/handle-parser.js';
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  ensureMaxTelegramHtmlLength,
  escapeAndClampHtml,
  escapeHtml,
  renderSafeHtmlLink,
  sanitizeTelegramHttpUrl,
} from './html-escape.js';

const CATEGORY_LABELS_RU: Readonly<Record<Web3LinkCategory, string>> = {
  launchpad: '🚀 Минт / Лаунчпад',
  raffle: '🎟 Раффл / Allowlist',
  marketplace: '🛒 Маркетплейс',
  discord: '💬 Discord',
  other: '🌐 Внешняя ссылка',
};

const FIELD_LABELS_RU: Readonly<Record<ProfileChangedField, string>> = {
  handle: '🆔 Юзернейм (@handle)',
  displayName: '📛 Имя профиля',
  bio: '📝 Описание (Bio)',
  websiteUrl: '🌐 Веб-сайт',
  avatarUrl: '🖼 Аватар',
  bannerUrl: '🏞 Баннер профиля',
  availability: '⚠️ Статус аккаунта',
};

export class TelegramFormatter {
  public static formatWelcomeMessage(mode: 'LIVE' | 'MOCK'): string {
    const modeLabel =
      mode === 'MOCK'
        ? '🧪 <b>MOCK-режим</b> (локальная эмуляция без расхода API)'
        : '🟢 <b>LIVE-режим</b> (TwitterAPI.io)';

    return ensureMaxTelegramHtmlLength(
      [
        '👋 <b>Мониторинг X (Twitter) NFT-аккаунтов</b>',
        `Режим работы: ${modeLabel}`,
        '',
        'Бот отслеживает посты, ретвиты, цитаты, смарт-контракты (<code>0x...</code>), минт-ссылки и изменения профилей (bio, сайт, смена @handle).',
        '',
        '<b>Основные команды:</b>',
        '• <code>/add @handle</code> или ссылка <code>https://x.com/...</code> — добавить аккаунт',
        '  <i>(можно просто отправить @handle или ссылку на X в чат без команды!)</i>',
        '• <code>/list</code> — список отслеживаемых аккаунтов и кнопки управления',
        '• <code>/remove @handle</code> — удалить аккаунт из отслеживания',
        '• <code>/keywords</code> — список NFT-триггеров',
        '• <code>/addkw слово1, слово2</code> — добавить ключевые слова',
        '• <code>/delkw слово</code> — удалить ключевое слово',
        '• <code>/status</code> — состояние сервиса, лимитов и ручная проверка',
        '• <code>/test_alert</code> — отправить тестовые уведомления (минт + профиль)',
      ].join('\n'),
    );
  }

  public static formatInvalidHandleError(reason: HandleParseErrorReason): string {
    switch (reason) {
      case 'EMPTY':
        return '⚠️ Укажите юзернейм или ссылку на профиль X.\nПример: <code>/add @boredapeyc</code> или <code>https://x.com/azuki</code>';
      case 'INVALID_DOMAIN':
        return '❌ Поддерживаются только ссылки на <code>x.com</code> или <code>twitter.com</code>.';
      case 'RESERVED_ROUTE':
        return '❌ Указана системная страница X, а не профиль пользователя.';
      case 'INVALID_FORMAT':
        return '❌ Некорректный формат @handle. Юзернейм X может содержать только латинские буквы, цифры и <code>_</code> (до 15 символов).';
    }
  }

  public static formatAccountCard(
    account: TrackedAccount,
    headerTitle: string,
    previousHandle?: string,
  ): string {
    const profileUrl = this.buildSafeXProfileUrl(account.handle, account.userId);
    const statusBadge = !account.enabled
      ? '⏸ На паузе'
      : account.availability === 'unavailable'
        ? `⚠️ Недоступен${account.unavailableReason ? ` (${escapeAndClampHtml(account.unavailableReason, 80)})` : ''}`
        : '🟢 Активен';
    const repliesBadge = account.includeReplies ? 'ВКЛ' : 'ВЫКЛ';
    const profileLink = renderSafeHtmlLink(
      profileUrl,
      `<b>@${escapeAndClampHtml(account.handle, 32)}</b>`,
    );

    const lines: string[] = [
      headerTitle,
      '',
      `👤 ${profileLink} — ${escapeAndClampHtml(account.displayName || account.handle, 80)}`,
      `🆔 ID: <code>${escapeAndClampHtml(account.userId, 48)}</code>`,
    ];

    if (previousHandle) {
      lines.push(
        `🔄 Обновлён юзернейм: <code>@${escapeAndClampHtml(previousHandle, 32)}</code> → <code>@${escapeAndClampHtml(account.handle, 32)}</code>`,
      );
    }

    lines.push(`📊 Статус: ${statusBadge}`);
    lines.push(`💬 Уведомления об ответах (replies): <b>${repliesBadge}</b>`);

    if (account.bio.trim().length > 0) {
      lines.push(`📝 Bio: ${escapeAndClampHtml(account.bio, 300)}`);
    }
    if (account.websiteUrl && account.websiteUrl.trim().length > 0) {
      const displaySite = escapeAndClampHtml(account.websiteUrl, 100);
      const siteFormatted = renderSafeHtmlLink(
        account.websiteUrl,
        displaySite,
        `<code>${displaySite}</code>`,
      );
      lines.push(`🌐 Сайт: ${siteFormatted}`);
    }

    return ensureMaxTelegramHtmlLength(lines.join('\n'));
  }

  public static formatAccountsList(paginated: PaginatedAccounts): string {
    if (paginated.total === 0) {
      return [
        '📋 <b>Список отслеживаемых аккаунтов пуст.</b>',
        '',
        'Отправьте <code>@handle</code>, ссылку <code>https://x.com/handle</code> или команду <code>/add @handle</code>, чтобы начать мониторинг.',
      ].join('\n');
    }

    const lines: string[] = [
      `📋 <b>Отслеживаемые аккаунты (${paginated.total})</b> · Стр. ${paginated.page}/${paginated.totalPages}`,
      '',
    ];

    for (const acc of paginated.items) {
      const icon = !acc.enabled
        ? '⏸'
        : acc.availability === 'unavailable'
          ? '⚠️'
          : '🟢';
      const repliesLabel = acc.includeReplies ? '💬 ВКЛ' : '💬 ВЫКЛ';
      const profileUrl = this.buildSafeXProfileUrl(acc.handle, acc.userId);
      const profileLink = renderSafeHtmlLink(
        profileUrl,
        `<b>@${escapeAndClampHtml(acc.handle, 32)}</b>`,
      );
      const namePart =
        acc.displayName.trim().length > 0
          ? ` (${escapeAndClampHtml(acc.displayName, 40)})`
          : '';
      lines.push(`${icon} ${profileLink}${namePart} · ${repliesLabel}`);
    }

    lines.push('');
    lines.push(
      '<i>Используйте кнопки ниже для переключения ответов (💬), паузы (⏸/▶️) или удаления (🗑).</i>',
    );

    return ensureMaxTelegramHtmlLength(lines.join('\n'));
  }

  public static formatKeywordsList(keywords: readonly string[]): string {
    if (keywords.length === 0) {
      return [
        '🏷 <b>Список триггерных ключевых слов пуст.</b>',
        '',
        'Добавьте слова командой: <code>/addkw mint, wl, allowlist</code>',
      ].join('\n');
    }

    const maxDisplayed = 70;
    const visible = keywords.slice(0, maxDisplayed);
    const formattedTags = visible
      .map((kw) => `<code>${escapeAndClampHtml(kw, 40)}</code>`)
      .join(', ');

    const lines: string[] = [
      `🏷 <b>Активные NFT-триггеры (${keywords.length}):</b>`,
      '',
      formattedTags,
    ];

    if (keywords.length > maxDisplayed) {
      lines.push(
        `<i>…и ещё ${keywords.length - maxDisplayed} ключевых слов</i>`,
      );
    }

    lines.push('');
    lines.push('• Добавить: <code>/addkw слово1, слово2</code>');
    lines.push('• Удалить: <code>/delkw слово</code>');

    return ensureMaxTelegramHtmlLength(lines.join('\n'));
  }

  public static formatTweetAlert(event: TweetAlertEvent): string {
    const budgets: readonly { main: number; ref: number; maxLinks: number }[] = [
      { main: 1800, ref: 550, maxLinks: 8 },
      { main: 900, ref: 280, maxLinks: 5 },
      { main: 400, ref: 140, maxLinks: 3 },
      { main: 160, ref: 80, maxLinks: 1 },
      { main: 80, ref: 0, maxLinks: 0 },
    ];

    for (const budget of budgets) {
      const candidate = this.renderTweetAlertWithBudget(
        event,
        budget.main,
        budget.ref,
        budget.maxLinks,
      );
      if (candidate.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        return candidate;
      }
    }

    return ensureMaxTelegramHtmlLength(
      this.renderTweetAlertWithBudget(event, 40, 0, 0),
    );
  }

  public static formatProfileAlert(event: ProfileAlertEvent): string {
    const budgets: readonly { fieldChars: number; maxLinks: number }[] = [
      { fieldChars: 420, maxLinks: 6 },
      { fieldChars: 200, maxLinks: 4 },
      { fieldChars: 90, maxLinks: 2 },
      { fieldChars: 40, maxLinks: 0 },
      { fieldChars: 25, maxLinks: 0 },
    ];

    for (const budget of budgets) {
      const candidate = this.renderProfileAlertWithBudget(
        event,
        budget.fieldChars,
        budget.maxLinks,
      );
      if (candidate.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        return candidate;
      }
    }

    return ensureMaxTelegramHtmlLength(
      this.renderProfileAlertWithBudget(event, 16, 0),
    );
  }

  public static formatSystemAlert(event: SystemAlertEvent): string {
    const icon = event.level === 'ERROR' ? '🛑' : '⚠️';
    const lines: string[] = [
      `${icon} <b>${escapeAndClampHtml(event.title, 140)}</b>`,
      '',
      escapeAndClampHtml(event.message, 1500),
    ];

    if (event.statusCode !== undefined) {
      lines.push(`\nКод ответа HTTP: <code>${event.statusCode}</code>`);
    }
    lines.push(`🕒 ${this.formatUtcTimestamp(event.occurredAtUnix)}`);

    return ensureMaxTelegramHtmlLength(lines.join('\n'));
  }

  public static formatStatusReport(status: MonitorStatusSnapshot): string {
    const modeLabel =
      status.mode === 'MOCK'
        ? '🧪 MOCK (локальная эмуляция)'
        : '🟢 LIVE (TwitterAPI.io)';

    const lines: string[] = [
      '📊 <b>Статус сервиса мониторинга X</b>',
      '',
      `⚙️ <b>Режим:</b> ${modeLabel}`,
      `⏱ <b>Аптайм:</b> ${this.formatDurationRu(status.uptimeSec)}`,
      `👥 <b>Аккаунты:</b> всего <b>${status.accounts.total}</b> (активных: <b>${status.accounts.active}</b>, пауза: <b>${status.accounts.paused}</b>, недоступных: <b>${status.accounts.unavailable}</b>)`,
      `🏷 <b>Ключевых слов:</b> ${status.keywordsCount}`,
      `🗄 <b>Кэш seen_tweets:</b> ${status.seenTweetsCount} записей`,
      '',
      `🐦 <b>Мониторинг твитов</b> (интервал ${status.tweetPollIntervalSec} сек):`,
      `• Состояние: ${status.tweetCycleRunning ? '🔄 выполняется опрос…' : '✅ ожидание'}`,
      `• Последняя проверка: ${status.lastTweetPollUnix ? this.formatUtcTimestamp(status.lastTweetPollUnix) : 'ещё не выполнялась'}`,
    ];

    if (status.lastTweetCycle && !status.lastTweetCycle.skipped) {
      lines.push(
        `• Результат цикла: батчей ${status.lastTweetCycle.batchesQueried}, получено ${status.lastTweetCycle.tweetsFetched}, новых ${status.lastTweetCycle.unseenTweets}, алертов ${status.lastTweetCycle.alertsSent}`,
      );
    }
    if (status.lastTweetError) {
      lines.push(
        `• ⚠️ Ошибка: <code>${escapeAndClampHtml(status.lastTweetError, 200)}</code>`,
      );
    }

    lines.push('');
    lines.push(
      `👤 <b>Мониторинг профилей</b> (интервал ${status.profilePollIntervalSec} сек):`,
    );
    lines.push(
      `• Состояние: ${status.profileCycleRunning ? '🔄 выполняется опрос…' : '✅ ожидание'}`,
    );
    lines.push(
      `• Последняя проверка: ${status.lastProfilePollUnix ? this.formatUtcTimestamp(status.lastProfilePollUnix) : 'ещё не выполнялась'}`,
    );

    if (status.lastProfileCycle && !status.lastProfileCycle.skipped) {
      lines.push(
        `• Результат цикла: проверено ${status.lastProfileCycle.profilesFetched}, изменений ${status.lastProfileCycle.changesDetected}, алертов ${status.lastProfileCycle.alertsSent}`,
      );
    }
    if (status.lastProfileError) {
      lines.push(
        `• ⚠️ Ошибка: <code>${escapeAndClampHtml(status.lastProfileError, 200)}</code>`,
      );
    }

    lines.push('');
    lines.push('🌐 <b>Статистика X провайдера и Rate Limiter:</b>');
    lines.push(
      `• Запросов выполнено: <b>${status.providerHealth.totalRequests}</b> (HTTP 429: <b>${status.providerHealth.rateLimitHits}</b>)`,
    );
    lines.push(
      `• Очередь запросов: HIGH=${status.providerHealth.queuedHigh}, NORMAL=${status.providerHealth.queuedNormal}`,
    );
    if (status.providerHealth.lastError) {
      lines.push(
        `• Последняя ошибка API: <code>${escapeAndClampHtml(status.providerHealth.lastError, 200)}</code>`,
      );
    }

    return ensureMaxTelegramHtmlLength(lines.join('\n'));
  }

  public static formatImmediateCheckSummary(
    result: ImmediateCheckResult,
  ): string {
    if (result.tweetCycle.skipped && result.profileCycle.skipped) {
      return 'ℹ️ Проверка завершена: сейчас нет активных отслеживаемых аккаунтов (0 запросов к API).';
    }

    return ensureMaxTelegramHtmlLength(
      [
        '✅ <b>Внеплановая проверка завершена</b>',
        '',
        `🐦 <b>Твиты:</b> получено ${result.tweetCycle.tweetsFetched}, новых ${result.tweetCycle.unseenTweets}, отправлено алертов: <b>${result.tweetCycle.alertsSent}</b>`,
        `👤 <b>Профили:</b> проверено ${result.profileCycle.profilesFetched}, изменений: <b>${result.profileCycle.changesDetected}</b>`,
      ].join('\n'),
    );
  }

  private static renderTweetAlertWithBudget(
    event: TweetAlertEvent,
    mainTextChars: number,
    refTextChars: number,
    maxLinks: number,
  ): string {
    const simPrefix = event.isSimulated ? '🧪 <b>[ТЕСТ]</b> ' : '';
    const header = this.formatTweetHeader(event.kind, event.signal.priority);
    const handle = event.tweet.authorHandle || event.account.handle;
    const displayName =
      event.tweet.authorDisplayName || event.account.displayName || handle;
    const profileUrl = this.buildSafeXProfileUrl(
      handle,
      event.tweet.authorId || event.account.userId,
    );
    const profileLink = renderSafeHtmlLink(
      profileUrl,
      `<b>@${escapeAndClampHtml(handle, 32)}</b>`,
    );

    const lines: string[] = [
      `${simPrefix}${header}`,
      `👤 ${profileLink} (${escapeAndClampHtml(displayName, 70)})`,
    ];

    if (event.kind === 'REPLY' && event.tweet.inReplyToHandle) {
      lines.push(
        `↪️ В ответ пользователю <code>@${escapeAndClampHtml(event.tweet.inReplyToHandle, 30)}</code>`,
      );
    }

    const bodyText =
      event.kind === 'RETWEET' && event.tweet.retweetedTweet
        ? event.tweet.retweetedTweet.text
        : event.tweet.text;

    if (bodyText.trim().length > 0) {
      lines.push('');
      if (
        event.kind === 'RETWEET' &&
        event.tweet.retweetedTweet?.authorHandle
      ) {
        lines.push(
          `🔁 Оригинал от <b>@${escapeAndClampHtml(event.tweet.retweetedTweet.authorHandle, 30)}</b>:`,
        );
      }
      lines.push(escapeAndClampHtml(bodyText.trim(), mainTextChars));
    }

    if (event.tweet.quotedTweet && refTextChars > 0) {
      const q = event.tweet.quotedTweet;
      const qAuthor = q.authorHandle
        ? `@${escapeAndClampHtml(q.authorHandle, 30)}: `
        : '';
      const qBody = escapeAndClampHtml(q.text.trim(), refTextChars);
      lines.push('');
      lines.push(`<blockquote>💬 ${qAuthor}${qBody}</blockquote>`);
    }

    const signalLines = this.renderSignalBlock(event.signal, maxLinks);
    if (signalLines.length > 0) {
      lines.push('');
      lines.push(...signalLines);
    }

    const safeTweetUrl = this.buildSafeXTweetUrl(
      event.tweet.url,
      handle,
      event.tweet.id,
    );
    const openLink = renderSafeHtmlLink(safeTweetUrl, '<b>Открыть в X</b>');

    lines.push('');
    lines.push(
      `🔗 ${openLink} · 🕒 ${this.formatUtcTimestamp(event.tweet.createdAtUnix)}`,
    );

    return lines.join('\n');
  }

  private static renderProfileAlertWithBudget(
    event: ProfileAlertEvent,
    fieldChars: number,
    maxLinks: number,
  ): string {
    const simPrefix = event.isSimulated ? '🧪 <b>[ТЕСТ]</b> ' : '';
    const header =
      event.diff.priority === 'HIGH'
        ? '🚨 <b>ВАЖНО · ИЗМЕНЕНИЕ ПРОФИЛЯ X</b>'
        : '👤 <b>Обновление профиля X</b>';

    const activeHandle =
      event.freshProfile.handle.trim().length > 0
        ? event.freshProfile.handle
        : event.account.handle;
    const profileUrl = this.buildSafeXProfileUrl(
      activeHandle,
      event.account.userId,
    );
    const displayName =
      event.freshProfile.displayName.trim() ||
      event.account.displayName.trim() ||
      activeHandle;

    const profileLink = renderSafeHtmlLink(
      profileUrl,
      `<b>@${escapeAndClampHtml(activeHandle, 32)}</b>`,
    );
    const openProfileLink = renderSafeHtmlLink(
      profileUrl,
      '<b>Открыть профиль в X</b>',
    );

    const lines: string[] = [
      `${simPrefix}${header}`,
      `👤 ${profileLink} (${escapeAndClampHtml(displayName, 70)})`,
      '',
    ];

    for (const change of event.diff.changes) {
      lines.push(...this.renderProfileFieldChange(change, fieldChars));
    }

    const signalLines = this.renderSignalBlock(event.diff.signal, maxLinks);
    if (signalLines.length > 0) {
      lines.push('');
      lines.push(...signalLines);
    }

    lines.push('');
    lines.push(
      `🔗 ${openProfileLink} · 🕒 ${this.formatUtcTimestamp(event.detectedAtUnix)}`,
    );

    return lines.join('\n');
  }

  private static renderProfileFieldChange(
    change: ProfileFieldChange,
    maxFieldChars: number,
  ): string[] {
    const label = FIELD_LABELS_RU[change.field];

    if (change.field === 'avatarUrl' || change.field === 'bannerUrl') {
      const beforePart = change.before
        ? renderSafeHtmlLink(
            change.before,
            'было',
            `<code>${escapeAndClampHtml(change.before, Math.min(60, maxFieldChars))}</code>`,
          )
        : '<i>пусто</i>';
      const afterPart = change.after
        ? renderSafeHtmlLink(
            change.after,
            'стало',
            `<code>${escapeAndClampHtml(change.after, Math.min(60, maxFieldChars))}</code>`,
          )
        : '<i>удалено</i>';
      return [`${label}: ${beforePart} → ${afterPart}`];
    }

    const beforeStr =
      change.before && change.before.trim().length > 0
        ? escapeAndClampHtml(change.before, maxFieldChars)
        : '<i>пусто</i>';
    const afterStr =
      change.after && change.after.trim().length > 0
        ? escapeAndClampHtml(change.after, maxFieldChars)
        : '<i>удалено</i>';

    if (change.field === 'handle') {
      return [`${label}: <code>${beforeStr}</code> → <code>${afterStr}</code>`];
    }

    return [
      `${label}:`,
      `  • Было: ${beforeStr}`,
      `  • Стало: <b>${afterStr}</b>`,
    ];
  }

  private static renderSignalBlock(
    signal: NftSignalAnalysis,
    maxLinks: number,
  ): string[] {
    const lines: string[] = [];

    if (signal.matchedKeywords.length > 0) {
      const kwTags = signal.matchedKeywords
        .slice(0, 12)
        .map((kw) => `<code>${escapeAndClampHtml(kw, 32)}</code>`)
        .join(', ');
      lines.push(`🏷 <b>Триггеры:</b> ${kwTags}`);
    }

    if (signal.evmAddresses.length > 0) {
      lines.push('💎 <b>Контракт EVM (нажмите для копирования):</b>');
      for (const addr of signal.evmAddresses.slice(0, 5)) {
        lines.push(`<code>${escapeHtml(addr)}</code>`);
      }
    }

    if (maxLinks > 0 && signal.links.length > 0) {
      lines.push('🔗 <b>Ссылки:</b>');
      const visibleLinks: readonly CategorizedLink[] = signal.links.slice(
        0,
        maxLinks,
      );
      for (const link of visibleLinks) {
        const catLabel = CATEGORY_LABELS_RU[link.category];
        const displayUrl = escapeAndClampHtml(link.url, 90);
        const safeLinkHtml = renderSafeHtmlLink(
          link.url,
          displayUrl,
          `<code>${displayUrl}</code>`,
        );
        lines.push(`• ${catLabel}: ${safeLinkHtml}`);
      }
      if (signal.links.length > maxLinks) {
        lines.push(
          `<i>…и ещё ${signal.links.length - maxLinks} ссылок в оригинале</i>`,
        );
      }
    }

    return lines;
  }

  private static buildSafeXProfileUrl(handle: string, userId?: string): string {
    const cleanHandle = handle.trim().replace(/^@+/, '');
    if (/^[A-Za-z0-9_]{1,15}$/.test(cleanHandle)) {
      return `https://x.com/${cleanHandle}`;
    }
    const cleanId = userId?.trim() ?? '';
    if (/^\d{1,30}$/.test(cleanId)) {
      return `https://x.com/i/user/${cleanId}`;
    }
    return 'https://x.com';
  }

  private static buildSafeXTweetUrl(
    rawUrl: string,
    handle: string,
    tweetId: string,
  ): string {
    const validated = sanitizeTelegramHttpUrl(rawUrl);
    if (validated !== null) {
      return validated;
    }

    const cleanHandle = handle.trim().replace(/^@+/, '');
    const userPath = /^[A-Za-z0-9_]{1,15}$/.test(cleanHandle)
      ? cleanHandle
      : 'i/web';
    const cleanTweetId = encodeURIComponent(tweetId.trim().slice(0, 64) || '0');
    return (
      sanitizeTelegramHttpUrl(`https://x.com/${userPath}/status/${cleanTweetId}`) ??
      'https://x.com'
    );
  }

  private static formatTweetHeader(
    kind: TweetKind,
    priority: 'HIGH' | 'NORMAL',
  ): string {
    const kindRu: Record<TweetKind, { high: string; normal: string }> = {
      POST: { high: 'НОВЫЙ ПОСТ', normal: 'Новый пост' },
      QUOTE: { high: 'ЦИТАТА (QUOTE)', normal: 'Цитата (Quote)' },
      RETWEET: { high: 'РЕТВИТ', normal: 'Ретвит' },
      REPLY: { high: 'ОТВЕТ (REPLY)', normal: 'Ответ (Reply)' },
    };

    const labels = kindRu[kind];
    if (priority === 'HIGH') {
      return `🚨 <b>ВАЖНЫЙ NFT-СИГНАЛ · ${labels.high}</b>`;
    }
    return `📢 <b>${labels.normal}</b>`;
  }

  public static formatUtcTimestamp(unixSeconds: number): string {
    if (!Number.isFinite(unixSeconds)) {
      return 'неизвестно';
    }
    const date = new Date(unixSeconds * 1000);
    if (Number.isNaN(date.getTime())) {
      return 'неизвестно';
    }
    try {
      const iso = date.toISOString();
      // YYYY-MM-DD HH:MM:SS UTC
      return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
    } catch {
      return 'неизвестно';
    }
  }

  public static formatDurationRu(totalSec: number): string {
    const sec = Number.isFinite(totalSec)
      ? Math.max(0, Math.floor(totalSec))
      : 0;
    const days = Math.floor(sec / 86_400);
    const hours = Math.floor((sec % 86_400) / 3_600);
    const mins = Math.floor((sec % 3_600) / 60);
    const secs = sec % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}д`);
    if (hours > 0) parts.push(`${hours}ч`);
    if (mins > 0) parts.push(`${mins}м`);
    if (parts.length === 0 || secs > 0) parts.push(`${secs}с`);
    return parts.join(' ');
  }
}
