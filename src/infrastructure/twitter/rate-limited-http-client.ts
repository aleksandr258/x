import type { Clock } from '../../application/ports/clock.js';
import type { Logger } from '../../application/ports/logger.js';
import type { RequestPriority } from '../../application/ports/twitter-provider.js';
import {
  TwitterProviderAuthOrQuotaError,
  TwitterProviderError,
  TwitterProviderHttpError,
  TwitterProviderRateLimitError,
} from './errors.js';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthOrQuotaAlertInfo {
  readonly statusCode: 401 | 402 | 403;
  readonly responseBody: string;
  readonly occurredAtUnix: number;
}

export interface RateLimitedHttpClientOptions {
  readonly minIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxQueueSize?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitterMaxMs?: number;
  readonly authAlertThrottleMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchFn?: FetchLike;
  readonly randomFn?: () => number;
  readonly onAuthOrQuotaError?: (
    info: AuthOrQuotaAlertInfo,
  ) => void | Promise<void>;
}

export interface HttpClientMetrics {
  readonly totalRequests: number;
  readonly rateLimitHits: number;
  readonly lastError: string | null;
  readonly lastErrorAtUnix: number | null;
  readonly lastRequestAtUnix: number | null;
  readonly queuedHigh: number;
  readonly queuedNormal: number;
}

interface QueuedRequest<T> {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal | undefined;
  readonly cleanupQueueAbort: () => void;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_AUTH_ALERT_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
const AUTH_ALERT_FAILURE_RETRY_COOLDOWN_MS = 60 * 1000; // 1 minute retry on failed alert delivery
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export class RateLimitedHttpClient {
  private readonly highQueue: QueuedRequest<unknown>[] = [];
  private readonly normalQueue: QueuedRequest<unknown>[] = [];
  private drainPromise: Promise<void> | null = null;

  private nextAllowedAtMs = 0;
  private totalRequests = 0;
  private rateLimitHits = 0;
  private lastError: string | null = null;
  private lastErrorAtUnix: number | null = null;
  private lastRequestAtUnix: number | null = null;

  private readonly lastAuthAlertAtByStatus = new Map<number, number>();
  private readonly fetchFn: FetchLike;
  private readonly randomFn: () => number;
  private readonly maxQueueSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterMaxMs: number;
  private readonly authAlertThrottleMs: number;

  public constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: RateLimitedHttpClientOptions,
  ) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.randomFn = options.randomFn ?? Math.random;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.baseBackoffMs =
      options.baseBackoffMs ?? Math.max(options.minIntervalMs, 6_000);
    this.maxBackoffMs = Math.max(1_000, options.maxBackoffMs ?? 60_000);
    this.jitterMaxMs = Math.max(0, options.jitterMaxMs ?? 1_500);
    this.authAlertThrottleMs =
      options.authAlertThrottleMs ?? DEFAULT_AUTH_ALERT_THROTTLE_MS;
  }

  public getJson<T = unknown>(
    url: string,
    options: {
      priority?: RequestPriority;
      headers?: Readonly<Record<string, string>>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    const totalQueued = this.highQueue.length + this.normalQueue.length;
    if (totalQueued >= this.maxQueueSize) {
      const overflowErr = new TwitterProviderError(
        `HTTP client request queue is full (max ${this.maxQueueSize})`,
      );
      this.recordError(overflowErr.message);
      return Promise.reject(overflowErr);
    }

    const priority: RequestPriority = options.priority ?? 'NORMAL';
    const mergedHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(this.options.defaultHeaders ?? {}),
      ...(options.headers ?? {}),
    };

    return new Promise<T>((resolve, reject) => {
      const targetQueue = priority === 'HIGH' ? this.highQueue : this.normalQueue;
      let detachQueueAbort: (() => void) | undefined;

      const item: QueuedRequest<unknown> = {
        url,
        headers: mergedHeaders,
        signal: options.signal,
        cleanupQueueAbort: () => {
          detachQueueAbort?.();
          detachQueueAbort = undefined;
        },
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (options.signal) {
        const sig = options.signal;
        const onQueueAbort = (): void => {
          const idx = targetQueue.indexOf(item);
          if (idx !== -1) {
            targetQueue.splice(idx, 1);
            reject(this.createAbortError());
          }
        };
        sig.addEventListener('abort', onQueueAbort, { once: true });
        detachQueueAbort = () => sig.removeEventListener('abort', onQueueAbort);
      }

      targetQueue.push(item);
      this.ensureDraining();
    });
  }

  public getMetrics(): HttpClientMetrics {
    return {
      totalRequests: this.totalRequests,
      rateLimitHits: this.rateLimitHits,
      lastError: this.lastError,
      lastErrorAtUnix: this.lastErrorAtUnix,
      lastRequestAtUnix: this.lastRequestAtUnix,
      queuedHigh: this.highQueue.length,
      queuedNormal: this.normalQueue.length,
    };
  }

  private ensureDraining(): void {
    if (this.drainPromise !== null) {
      return;
    }

    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = null;
      if (this.highQueue.length > 0 || this.normalQueue.length > 0) {
        this.ensureDraining();
      }
    });
  }

  private async drainLoop(): Promise<void> {
    while (true) {
      const nextItem = this.highQueue.shift() ?? this.normalQueue.shift();
      if (nextItem === undefined) {
        break;
      }

      nextItem.cleanupQueueAbort();

      if (nextItem.signal?.aborted) {
        nextItem.reject(this.createAbortError());
        continue;
      }

      try {
        const payload = await this.executeWithRetry(nextItem);
        nextItem.resolve(payload);
      } catch (err) {
        nextItem.reject(err);
      }
    }
  }

  private async executeWithRetry(item: QueuedRequest<unknown>): Promise<unknown> {
    const maxAttempts = Math.max(1, this.options.maxRetries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (item.signal?.aborted) {
        throw this.createAbortError();
      }

      const waitMs = this.nextAllowedAtMs - this.clock.nowMs();
      if (waitMs > 0) {
        await this.clock.sleep(waitMs, item.signal);
        if (item.signal?.aborted) {
          throw this.createAbortError();
        }
      }

      const startedAtMs = this.clock.nowMs();
      this.nextAllowedAtMs = startedAtMs + this.options.minIntervalMs;
      this.totalRequests += 1;
      this.lastRequestAtUnix = this.clock.nowUnix();

      const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
      const combinedSignal = item.signal
        ? AbortSignal.any([item.signal, timeoutSignal])
        : timeoutSignal;

      let response: Response;
      let rawText = '';
      try {
        response = await this.fetchFn(item.url, {
          method: 'GET',
          headers: item.headers,
          signal: combinedSignal,
        });
        rawText = await response.text();
      } catch (err) {
        if (item.signal?.aborted) {
          throw this.createAbortError();
        }

        const msg = err instanceof Error ? err.message : String(err);
        this.recordError(`Network/timeout error: ${msg}`);

        if (attempt + 1 < maxAttempts) {
          const backoffMs = this.computeBackoffMs(attempt, null);
          this.nextAllowedAtMs = Math.max(
            this.nextAllowedAtMs,
            this.clock.nowMs() + backoffMs,
          );
          this.logger.warn('Transient HTTP network error, scheduling retry', {
            attempt: attempt + 1,
            maxAttempts,
            backoffMs,
            error: msg,
          });
          continue;
        }

        throw new TwitterProviderError(
          `HTTP request failed after ${maxAttempts} attempt(s): ${msg}`,
          { cause: err },
        );
      }

      if (response.ok) {
        try {
          return JSON.parse(rawText) as unknown;
        } catch (parseErr) {
          this.recordError('Invalid JSON response from Twitter provider');
          throw new TwitterProviderError(
            'Failed to parse JSON response from Twitter provider',
            { cause: parseErr },
          );
        }
      }

      const status = response.status;
      const bodySnippet = rawText.slice(0, 500);

      if (status === 401 || status === 402 || status === 403) {
        const authErr = new TwitterProviderAuthOrQuotaError(status, bodySnippet);
        this.recordError(authErr.message);
        this.notifyAuthOrQuotaThrottled(status, bodySnippet);
        throw authErr;
      }

      if (RETRYABLE_HTTP_STATUSES.has(status)) {
        const retryAfterMs = this.parseRetryAfterMs(
          response.headers.get('retry-after'),
        );
        if (status === 429) {
          this.rateLimitHits += 1;
        }
        this.recordError(`HTTP ${status}: ${bodySnippet.slice(0, 160)}`);

        const backoffMs = this.computeBackoffMs(attempt, retryAfterMs);
        this.nextAllowedAtMs = Math.max(
          this.nextAllowedAtMs,
          this.clock.nowMs() + backoffMs,
        );

        if (attempt + 1 < maxAttempts) {
          this.logger.warn('Retryable HTTP status from Twitter provider', {
            status,
            attempt: attempt + 1,
            maxAttempts,
            backoffMs,
          });
          continue;
        }

        if (status === 429) {
          throw new TwitterProviderRateLimitError(
            `Rate limit exceeded (HTTP 429) after ${maxAttempts} attempts`,
            bodySnippet,
            retryAfterMs,
          );
        }

        throw new TwitterProviderHttpError(
          `Twitter provider server error (HTTP ${status}) after ${maxAttempts} attempts`,
          status,
          bodySnippet,
        );
      }

      this.recordError(`HTTP ${status}: ${bodySnippet.slice(0, 160)}`);
      throw new TwitterProviderHttpError(
        `Twitter provider HTTP ${status}`,
        status,
        bodySnippet,
      );
    }

    throw new TwitterProviderError('Exhausted HTTP request retries');
  }

  private computeBackoffMs(
    attempt: number,
    retryAfterMs: number | null,
  ): number {
    const jitter = Math.floor(this.randomFn() * this.jitterMaxMs);
    if (retryAfterMs !== null) {
      const base =
        retryAfterMs > 0
          ? retryAfterMs
          : Math.max(this.options.minIntervalMs, 1_000);
      return Math.min(this.maxBackoffMs, base + jitter);
    }
    const exp = this.baseBackoffMs * Math.pow(2, attempt);
    return Math.min(this.maxBackoffMs, exp + jitter);
  }

  private parseRetryAfterMs(headerValue: string | null): number | null {
    if (!headerValue || headerValue.trim().length === 0) {
      return null;
    }
    const trimmed = headerValue.trim();

    // Strictly match delta-seconds (e.g. "12" or "2.5") so ISO dates like "2026-11-08..."
    // are never misparsed as "2026" seconds by parseFloat.
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const seconds = Number.parseFloat(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(this.maxBackoffMs, Math.ceil(seconds * 1000));
      }
    }

    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
      const deltaMs = Math.max(0, dateMs - this.clock.nowMs());
      return Math.min(this.maxBackoffMs, deltaMs);
    }
    return null;
  }

  private notifyAuthOrQuotaThrottled(
    statusCode: 401 | 402 | 403,
    responseBody: string,
  ): void {
    if (!this.options.onAuthOrQuotaError) {
      return;
    }

    const nowMs = this.clock.nowMs();
    const lastSentAt = this.lastAuthAlertAtByStatus.get(statusCode);
    if (
      lastSentAt !== undefined &&
      nowMs - lastSentAt < this.authAlertThrottleMs
    ) {
      return;
    }

    this.lastAuthAlertAtByStatus.set(statusCode, nowMs);

    Promise.resolve(
      this.options.onAuthOrQuotaError({
        statusCode,
        responseBody,
        occurredAtUnix: this.clock.nowUnix(),
      }),
    ).catch((err: unknown) => {
      // Allow re-attempt after a short 60s cooldown instead of suppressing for 30m on transient Telegram failure
      const retryCooldown = Math.min(
        AUTH_ALERT_FAILURE_RETRY_COOLDOWN_MS,
        this.authAlertThrottleMs,
      );
      this.lastAuthAlertAtByStatus.set(
        statusCode,
        this.clock.nowMs() - this.authAlertThrottleMs + retryCooldown,
      );
      this.logger.error('Failed to dispatch auth/quota system alert', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAtUnix = this.clock.nowUnix();
  }

  private createAbortError(): Error {
    const err = new Error('HTTP request aborted');
    err.name = 'AbortError';
    return err;
  }
}
