import type { Transformer } from 'grammy';
import type { Clock } from '../../application/ports/clock.js';
import type { Logger } from '../../application/ports/logger.js';

export interface TelegramRetryTransformerOptions {
  readonly maxRetries?: number;
  readonly extraBufferMs?: number;
  readonly maxRetryAfterSec?: number;
  readonly serverErrorBaseDelayMs?: number;
}

/**
 * grammY API transformer that intercepts:
 * 1) Telegram HTTP 429 flood-control responses (`parameters.retry_after` + safety buffer)
 * 2) Transient 5xx (`500/502/503/504`) gateway errors on outbound bot calls
 * 3) Transient network/connection-reset errors on outbound bot calls (excluding `getUpdates`,
 *    which grammY's long-polling loop manages directly).
 */
export function createTelegramRetryTransformer(
  clock: Clock,
  logger: Logger,
  options: TelegramRetryTransformerOptions = {},
): Transformer {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const extraBufferMs = Math.max(0, options.extraBufferMs ?? 250);
  const maxRetryAfterSec = Math.max(1, options.maxRetryAfterSec ?? 60);
  const serverErrorBaseDelayMs = Math.max(
    100,
    options.serverErrorBaseDelayMs ?? 1_000,
  );

  return async (prev, method, payload, signal) => {
    let attempt = 0;

    while (true) {
      let response: Awaited<ReturnType<typeof prev>>;
      try {
        response = await prev(method, payload, signal);
      } catch (err) {
        if (
          method === 'getUpdates' ||
          attempt >= maxRetries ||
          signal?.aborted ||
          isAbortLikeError(err)
        ) {
          throw err;
        }

        attempt += 1;
        const waitMs = serverErrorBaseDelayMs * Math.pow(2, attempt - 1);
        logger.warn('Transient Telegram network error, retrying API call', {
          method,
          attempt,
          maxRetries,
          waitMs,
          error: err instanceof Error ? err.message : String(err),
        });

        const nativeSignal = bridgeAbortSignal(signal);
        await clock.sleep(waitMs, nativeSignal);
        if (signal?.aborted) {
          throw err;
        }
        continue;
      }

      if (response.ok || attempt >= maxRetries || signal?.aborted) {
        return response;
      }

      if (response.error_code === 429) {
        const retryAfterSec = response.parameters?.retry_after ?? 3;
        if (retryAfterSec <= 0 || retryAfterSec > maxRetryAfterSec) {
          return response;
        }

        attempt += 1;
        const waitMs = retryAfterSec * 1000 + extraBufferMs;

        logger.warn('Telegram API 429 flood control hit, backing off', {
          method,
          attempt,
          maxRetries,
          retryAfterSec,
          waitMs,
        });

        const nativeSignal = bridgeAbortSignal(signal);
        await clock.sleep(waitMs, nativeSignal);
        if (signal?.aborted) {
          return response;
        }
        continue;
      }

      if (method !== 'getUpdates' && response.error_code >= 500) {
        attempt += 1;
        const waitMs =
          serverErrorBaseDelayMs * Math.pow(2, attempt - 1) + extraBufferMs;

        logger.warn('Telegram API 5xx server error, backing off', {
          method,
          errorCode: response.error_code,
          attempt,
          maxRetries,
          waitMs,
        });

        const nativeSignal = bridgeAbortSignal(signal);
        await clock.sleep(waitMs, nativeSignal);
        if (signal?.aborted) {
          return response;
        }
        continue;
      }

      return response;
    }
  };
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function bridgeAbortSignal(
  sig: Parameters<Transformer>[3],
): globalThis.AbortSignal | undefined {
  if (!sig) {
    return undefined;
  }
  if (sig instanceof globalThis.AbortSignal) {
    return sig;
  }
  const controller = new globalThis.AbortController();
  if (sig.aborted) {
    controller.abort();
  } else {
    sig.addEventListener('abort', () => controller.abort());
  }
  return controller.signal;
}
