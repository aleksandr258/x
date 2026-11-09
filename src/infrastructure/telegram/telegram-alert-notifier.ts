import { GrammyError, type Api } from 'grammy';
import {
  AlertDeliveryError,
  type AlertNotifier,
} from '../../application/ports/alert-notifier.js';
import type { Logger } from '../../application/ports/logger.js';
import type {
  ProfileAlertEvent,
  SystemAlertEvent,
  TweetAlertEvent,
} from '../../domain/entities/alerts.js';
import { stripHtmlToPlainText } from './html-escape.js';
import { TelegramFormatter } from './telegram-formatter.js';

export class TelegramAlertNotifier implements AlertNotifier {
  public constructor(
    private readonly api: Api,
    private readonly adminChatIds: readonly string[],
    private readonly logger: Logger,
  ) {}

  public async sendTweetAlert(event: TweetAlertEvent): Promise<void> {
    const html = TelegramFormatter.formatTweetAlert(event);
    await this.broadcastHtml(html, {
      kind: 'tweet_alert',
      tweetId: event.tweet.id,
      handle: event.account.handle,
      priority: event.signal.priority,
    });
  }

  public async sendProfileAlert(event: ProfileAlertEvent): Promise<void> {
    const html = TelegramFormatter.formatProfileAlert(event);
    await this.broadcastHtml(html, {
      kind: 'profile_alert',
      userId: event.account.userId,
      handle: event.freshProfile.handle,
      priority: event.diff.priority,
    });
  }

  public async sendSystemAlert(event: SystemAlertEvent): Promise<void> {
    const html = TelegramFormatter.formatSystemAlert(event);
    await this.broadcastHtml(html, {
      kind: 'system_alert',
      level: event.level,
      statusCode: event.statusCode,
    });
  }

  private async broadcastHtml(
    html: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (this.adminChatIds.length === 0) {
      return;
    }

    let deliveredCount = 0;
    const failures: { readonly err: unknown; readonly retryable: boolean }[] = [];

    for (const chatId of this.adminChatIds) {
      try {
        await this.api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        deliveredCount += 1;
      } catch (err) {
        if (this.isHtmlFormatRejection(err)) {
          try {
            const plainFallback = stripHtmlToPlainText(html);
            await this.api.sendMessage(chatId, plainFallback, {
              link_preview_options: { is_disabled: true },
            });
            deliveredCount += 1;
            this.logger.warn(
              'Delivered Telegram alert via plain-text fallback after HTML entity rejection',
              {
                chatId,
                ...meta,
                originalError: err instanceof Error ? err.message : String(err),
              },
            );
            continue;
          } catch (fallbackErr) {
            const retryable = this.isRetryableTelegramError(fallbackErr);
            failures.push({ err: fallbackErr, retryable });
            this.logger.error(
              'Failed to deliver Telegram plain-text fallback alert to admin chat',
              {
                chatId,
                ...meta,
                retryable,
                error:
                  fallbackErr instanceof Error
                    ? fallbackErr.message
                    : String(fallbackErr),
              },
            );
            continue;
          }
        }

        const retryable = this.isRetryableTelegramError(err);
        failures.push({ err, retryable });
        this.logger.error('Failed to deliver Telegram alert to admin chat', {
          chatId,
          ...meta,
          retryable,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (deliveredCount === 0 && failures.length > 0) {
      const anyRetryable = failures.some((f) => f.retryable);
      const lastFailure = failures[failures.length - 1]!.err;
      const reason =
        lastFailure instanceof Error ? lastFailure.message : String(lastFailure);

      throw new AlertDeliveryError(
        `Failed to deliver Telegram alert to any admin chat: ${reason}`,
        {
          retryable: anyRetryable,
          cause: lastFailure,
        },
      );
    }
  }

  private isHtmlFormatRejection(err: unknown): boolean {
    const code = this.extractTelegramErrorCode(err);
    if (code !== 400) {
      return false;
    }
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes("can't parse entities") ||
      msg.includes('unsupported url protocol') ||
      msg.includes('message is too long') ||
      msg.includes('entity')
    );
  }

  private isRetryableTelegramError(err: unknown): boolean {
    const code = this.extractTelegramErrorCode(err);
    if (code !== null) {
      // 429 Too Many Requests & 5xx Server Errors are transient/retryable.
      // Other 4xx errors (400 chat not found, 401 unauthorized, 403 bot blocked) are permanent client errors.
      return code === 429 || code >= 500;
    }
    return true;
  }

  private extractTelegramErrorCode(err: unknown): number | null {
    if (err instanceof GrammyError) {
      return err.error_code;
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      'error_code' in err &&
      typeof (err as { error_code: unknown }).error_code === 'number'
    ) {
      return (err as { error_code: number }).error_code;
    }
    return null;
  }
}
