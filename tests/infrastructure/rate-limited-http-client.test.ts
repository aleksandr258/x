import { describe, expect, it } from 'vitest';
import { SystemClock, type Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import {
  TwitterProviderAuthOrQuotaError,
  TwitterProviderError,
  TwitterProviderHttpError,
  TwitterProviderRateLimitError,
} from '../../src/infrastructure/twitter/errors.js';
import {
  RateLimitedHttpClient,
  type AuthOrQuotaAlertInfo,
} from '../../src/infrastructure/twitter/rate-limited-http-client.js';

class VirtualClock implements Clock {
  public currentMs = Date.parse('2026-11-08T14:30:00Z');
  public readonly sleeps: number[] = [];

  public nowMs(): number {
    return this.currentMs;
  }

  public nowUnix(): number {
    return Math.floor(this.currentMs / 1000);
  }

  public async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    this.sleeps.push(ms);
    this.currentMs += Math.max(0, ms);
  }
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('RateLimitedHttpClient', () => {
  it('paces requests >= minIntervalMs and prioritizes HIGH lane ahead of queued NORMAL requests', async () => {
    const clock = new VirtualClock();
    const callOrder: { url: string; atMs: number }[] = [];

    const client = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 5500,
      timeoutMs: 10000,
      maxRetries: 2,
      randomFn: () => 0,
      fetchFn: async (input) => {
        const url = String(input);
        callOrder.push({ url, atMs: clock.nowMs() });
        await Promise.resolve();
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    });

    const p1 = client.getJson<{ url: string }>('https://api.test/normal-1', {
      priority: 'NORMAL',
    });
    const p2 = client.getJson<{ url: string }>('https://api.test/normal-2', {
      priority: 'NORMAL',
    });
    const pHigh = client.getJson<{ url: string }>('https://api.test/high-add', {
      priority: 'HIGH',
    });

    await Promise.all([p1, p2, pHigh]);

    expect(callOrder.map((c) => c.url)).toEqual([
      'https://api.test/normal-1',
      'https://api.test/high-add',
      'https://api.test/normal-2',
    ]);

    expect(callOrder[1]!.atMs - callOrder[0]!.atMs).toBeGreaterThanOrEqual(5500);
    expect(callOrder[2]!.atMs - callOrder[1]!.atMs).toBeGreaterThanOrEqual(5500);
  });

  it('backs off and retries on HTTP 429 honoring delta-seconds, RFC-1123 HTTP-date, ISO-8601 date, and caps bogus values', async () => {
    const clock = new VirtualClock();
    let scenarioAttempt = 0;

    const client = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 5500,
      timeoutMs: 10000,
      maxRetries: 4,
      maxBackoffMs: 45_000,
      jitterMaxMs: 0,
      randomFn: () => 0,
      fetchFn: async () => {
        scenarioAttempt += 1;
        if (scenarioAttempt === 1) {
          // 1) Delta-seconds
          return new Response('429', {
            status: 429,
            headers: { 'Retry-After': '12' },
          });
        }
        if (scenarioAttempt === 2) {
          // 2) ISO-8601 date 15s in the future (must NOT be parsed as 2026s by parseFloat!)
          const isoFuture = new Date(clock.nowMs() + 15_000).toISOString();
          return new Response('429', {
            status: 429,
            headers: { 'Retry-After': isoFuture },
          });
        }
        if (scenarioAttempt === 3) {
          // 3) RFC-1123 HTTP-date 9s in the future
          const rfcFuture = new Date(clock.nowMs() + 9_000).toUTCString();
          return new Response('429', {
            status: 429,
            headers: { 'Retry-After': rfcFuture },
          });
        }
        if (scenarioAttempt === 4) {
          // 4) Huge bogus Retry-After -> must be capped to maxBackoffMs (45_000ms)
          return new Response('429', {
            status: 429,
            headers: { 'Retry-After': '999999999' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const res = await client.getJson<{ ok: boolean }>('https://api.test/search');
    expect(res).toEqual({ ok: true });
    expect(scenarioAttempt).toBe(5);
    expect(clock.sleeps).toEqual([12_000, 15_000, 9_000, 45_000]);
    expect(client.getMetrics().rateLimitHits).toBe(4);
  });

  it('throws TwitterProviderRateLimitError after exhausting 429 retries and TwitterProviderHttpError after 503 retries', async () => {
    const clock = new VirtualClock();
    const client429 = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 1000,
      timeoutMs: 5000,
      maxRetries: 1,
      maxBackoffMs: 10_000,
      jitterMaxMs: 0,
      fetchFn: async () =>
        new Response('rate limit', {
          status: 429,
          headers: { 'Retry-After': '999999' },
        }),
    });

    let caught429: unknown;
    try {
      await client429.getJson('https://api.test/x');
    } catch (err) {
      caught429 = err;
    }
    expect(caught429).toBeInstanceOf(TwitterProviderRateLimitError);
    expect((caught429 as TwitterProviderRateLimitError).retryAfterMs).toBe(10_000);

    const client503 = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 1000,
      timeoutMs: 5000,
      maxRetries: 2,
      jitterMaxMs: 0,
      fetchFn: async () => new Response('Service Unavailable', { status: 503 }),
    });

    await expect(client503.getJson('https://api.test/x')).rejects.toBeInstanceOf(
      TwitterProviderHttpError,
    );
    expect(client429.getMetrics().rateLimitHits).toBe(2);
  });

  it('handles malformed JSON and hung socket/body-stream timeouts safely', async () => {
    const realClock = new SystemClock();

    const malformedClient = new RateLimitedHttpClient(realClock, noopLogger, {
      minIntervalMs: 0,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchFn: async () => new Response('<html>502 gateway</html>', { status: 200 }),
    });

    await expect(
      malformedClient.getJson('https://api.test/bad-json'),
    ).rejects.toThrow(/Failed to parse JSON/);

    // Simulate hung TCP socket obeying AbortSignal.timeout(40ms)
    let attempts = 0;
    const timeoutClient = new RateLimitedHttpClient(realClock, noopLogger, {
      minIntervalMs: 0,
      timeoutMs: 35,
      maxRetries: 1,
      baseBackoffMs: 10,
      jitterMaxMs: 0,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          attempts += 1;
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('timed out')),
            { once: true },
          );
        }),
    });

    await expect(
      timeoutClient.getJson('https://api.test/hung'),
    ).rejects.toBeInstanceOf(TwitterProviderError);
    expect(attempts).toBe(2);
  });

  it('enforces bounded maxQueueSize so hung upstream cannot leak unbounded RAM', async () => {
    const clock = new VirtualClock();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => {
      releaseFirst = res;
    });

    const client = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 100,
      timeoutMs: 10_000,
      maxRetries: 0,
      maxQueueSize: 2,
      fetchFn: async () => {
        await firstGate;
        return new Response('{"ok":true}', { status: 200 });
      },
    });

    // Item 1 starts draining immediately; items 2 and 3 fill maxQueueSize=2
    const p1 = client.getJson('https://api.test/1');
    const p2 = client.getJson('https://api.test/2');
    const p3 = client.getJson('https://api.test/3');

    // Item 4 exceeds maxQueueSize -> rejected immediately!
    await expect(client.getJson('https://api.test/4')).rejects.toThrow(
      /queue is full/,
    );

    releaseFirst();
    await Promise.all([p1, p2, p3]);
  });

  it('wakes up immediately on AbortSignal during queue wait, pacing sleep, and retry backoff sleep', async () => {
    const realClock = new SystemClock();
    let releaseInFlight!: () => void;
    const inFlightGate = new Promise<void>((res) => {
      releaseInFlight = res;
    });

    let callIndex = 0;
    const client = new RateLimitedHttpClient(realClock, noopLogger, {
      minIntervalMs: 60_000, // 60s pacing sleep!
      timeoutMs: 60_000,
      maxRetries: 2,
      baseBackoffMs: 60_000,
      jitterMaxMs: 0,
      fetchFn: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          await inFlightGate;
        }
        return new Response('{"ok":true}', { status: 200 });
      },
    });

    // 1) Request 1 holds the worker; Request 2 is queued behind it, then aborted while queued
    const p1 = client.getJson('https://api.test/inflight');
    const queuedAbort = new AbortController();
    const pQueued = client.getJson('https://api.test/queued', {
      signal: queuedAbort.signal,
    });

    expect(client.getMetrics().queuedNormal).toBe(1);
    queuedAbort.abort();

    await expect(pQueued).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.getMetrics().queuedNormal).toBe(0);

    releaseInFlight();
    await p1;

    // 2) Next request enters 60,000ms pacing sleep -> abort wakes it in <50ms!
    const sleepAbort = new AbortController();
    const startedMs = Date.now();
    const pSleeping = client.getJson('https://api.test/sleeping', {
      signal: sleepAbort.signal,
    });
    setTimeout(() => sleepAbort.abort(), 15);

    await expect(pSleeping).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedMs).toBeLessThan(500);
  });

  it('fails immediately without retry on HTTP 401/402/403, throttles alerts, and retries alert faster if alert callback fails', async () => {
    const clock = new VirtualClock();
    let fetchCalls = 0;
    let failNotifierOnce = true;
    const alerts: AuthOrQuotaAlertInfo[] = [];

    const client = new RateLimitedHttpClient(clock, noopLogger, {
      minIntervalMs: 5500,
      timeoutMs: 10000,
      maxRetries: 3,
      authAlertThrottleMs: 1_800_000,
      fetchFn: async () => {
        fetchCalls += 1;
        return new Response('{"msg":"Insufficient credits"}', { status: 402 });
      },
      onAuthOrQuotaError: async (info) => {
        if (failNotifierOnce) {
          failNotifierOnce = false;
          throw new Error('Telegram temporary network failure');
        }
        alerts.push(info);
      },
    });

    // First 402: onAuthOrQuotaError fails -> sets 60s short retry cooldown instead of 30m suppression!
    await expect(client.getJson('https://api.test/q1')).rejects.toBeInstanceOf(
      TwitterProviderAuthOrQuotaError,
    );
    await Promise.resolve();
    expect(fetchCalls).toBe(1);
    expect(alerts).toHaveLength(0);

    // 61s later (well before 30m): alert succeeds!
    clock.currentMs += 61_000;
    await expect(client.getJson('https://api.test/q2')).rejects.toBeInstanceOf(
      TwitterProviderAuthOrQuotaError,
    );
    await Promise.resolve();
    expect(alerts).toHaveLength(1);

    // 5 minutes later (within 30m throttle window): suppressed
    clock.currentMs += 300_000;
    await expect(client.getJson('https://api.test/q3')).rejects.toBeInstanceOf(
      TwitterProviderAuthOrQuotaError,
    );
    expect(alerts).toHaveLength(1);

    // Past 30-minute throttle window: fires again
    clock.currentMs += 1_800_001;
    await expect(client.getJson('https://api.test/q4')).rejects.toBeInstanceOf(
      TwitterProviderAuthOrQuotaError,
    );
    expect(alerts).toHaveLength(2);
  });
});
