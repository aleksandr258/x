import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import type { TrackedAccount } from '../../src/domain/entities/account.js';
import type {
  ProfileAlertEvent,
  TweetAlertEvent,
} from '../../src/domain/entities/alerts.js';
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  clampPlainText,
  escapeAndClampHtml,
  sanitizeTelegramHttpUrl,
} from '../../src/infrastructure/telegram/html-escape.js';
import { createTelegramRetryTransformer } from '../../src/infrastructure/telegram/retry-transformer.js';
import { encodeCallbackData } from '../../src/infrastructure/telegram/telegram-bot.js';
import { TelegramFormatter } from '../../src/infrastructure/telegram/telegram-formatter.js';

const sampleAccount: TrackedAccount = {
  userId: '18446744073709551615',
  handle: 'xss_nft',
  displayName: 'Alpha <script>alert("x")</script> & Co',
  bio: 'Bio <3 & "quotes"',
  websiteUrl: 'https://mint.example.com?a=1&b=2',
  avatarUrl: null,
  bannerUrl: null,
  includeReplies: false,
  enabled: true,
  availability: 'available',
  unavailableReason: null,
  consecutiveMisses: 0,
  baselineAt: 1700000000,
  lastTweetSeenAt: null,
  lastProfileCheckedAt: null,
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

function assertBalancedHtmlTags(html: string): void {
  for (const tag of ['b', 'i', 'code', 'blockquote', 'a']) {
    const openRegex = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
    const closeRegex = new RegExp(`</${tag}>`, 'g');
    const opens = (html.match(openRegex) ?? []).length;
    const closes = (html.match(closeRegex) ?? []).length;
    expect(opens, `Balanced <${tag}> count`).toBe(closes);
  }
}

function assertNoUnpairedSurrogates(str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      expect(
        next >= 0xdc00 && next <= 0xdfff,
        `High surrogate at index ${i} must be paired with low surrogate`,
      ).toBe(true);
      i += 1;
    } else {
      expect(
        code >= 0xdc00 && code <= 0xdfff,
        `Unexpected lone low surrogate at index ${i}`,
      ).toBe(false);
    }
  }
}

function assertSafeTelegramHrefProtocols(html: string): void {
  const hrefMatches = html.matchAll(/<a\s+href="([^"]*)"/g);
  for (const m of hrefMatches) {
    const href = m[1] ?? '';
    expect(
      href.startsWith('http://') || href.startsWith('https://'),
      `Unsafe <a href="${href}"> protocol detected`,
    ).toBe(true);
  }
}

describe('TelegramFormatter, Unicode Surrogate Safety & Protocol Validation', () => {
  it('escapes untrusted HTML, formats <code>0x...</code>, and clamps monstrous tweets <= 4096 chars with valid tags', () => {
    const hugeText = `${'🚀 <mint & claim> '.repeat(350)} 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D`;
    const manyLinks = Array.from({ length: 15 }, (_, idx) => ({
      url: `https://claim.manifold.xyz/drop-${idx}?ref=a&b=c`,
      hostname: 'claim.manifold.xyz',
      category: 'launchpad' as const,
    }));

    const event: TweetAlertEvent = {
      account: sampleAccount,
      kind: 'QUOTE',
      tweet: {
        id: '999',
        authorId: sampleAccount.userId,
        authorHandle: sampleAccount.handle,
        authorDisplayName: sampleAccount.displayName,
        text: hugeText,
        createdAtUnix: 1700000500,
        url: 'https://x.com/xss_nft/status/999',
        isReply: false,
        inReplyToTweetId: null,
        inReplyToHandle: null,
        retweetedTweet: null,
        quotedTweet: {
          id: '888',
          authorId: '777',
          authorHandle: 'quote_user',
          authorDisplayName: 'Quote <img src=x>',
          text: 'Quoted <tag> text '.repeat(120),
          expandedUrls: [],
          url: 'https://x.com/quote_user/status/888',
        },
        expandedUrls: manyLinks.map((l) => l.url),
      },
      signal: {
        priority: 'HIGH',
        matchedKeywords: ['mint', 'claim', 'wl'],
        evmAddresses: ['0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'],
        links: manyLinks,
      },
    };

    const html = TelegramFormatter.formatTweetAlert(event);

    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain(
      '<code>0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D</code>',
    );
    assertBalancedHtmlTags(html);
    assertNoUnpairedSurrogates(html);
    assertSafeTelegramHrefProtocols(html);
  });

  it('never splits UTF-16 surrogate pairs or ZWJ emojis and heals corrupted lone surrogates', () => {
    const emojiStream = '🔥🚀💎👨‍💻🏳️‍🌈'.repeat(40);
    for (let budget = 1; budget <= 35; budget += 1) {
      const clamped = clampPlainText(emojiStream, budget);
      expect(clamped.length).toBeLessThanOrEqual(budget);
      assertNoUnpairedSurrogates(clamped);

      const escaped = escapeAndClampHtml(`${emojiStream} <a & "b">`, budget);
      assertNoUnpairedSurrogates(escaped);
      // Verify no truncated entity at the end
      expect(escaped).not.toMatch(/&(?:amp|lt|gt|quot)?$/);
    }

    // Corrupted lone high/low surrogates in untrusted input are sanitized to U+FFFD
    const corrupted = `Mint \ud83d live \ude80 now <3`;
    const safeHtml = escapeAndClampHtml(corrupted, 100);
    assertNoUnpairedSurrogates(safeHtml);
    expect(safeHtml).toContain('\ufffd');
    expect(safeHtml).toContain('&lt;3');

    // Pure emoji wall (3500 emojis = 7000 UTF-16 units) stays <= 4096 UTF-16 units!
    const wallEvent: TweetAlertEvent = {
      account: sampleAccount,
      kind: 'POST',
      tweet: {
        id: '1000',
        authorId: sampleAccount.userId,
        authorHandle: sampleAccount.handle,
        authorDisplayName: '🔥'.repeat(80),
        text: '🔥'.repeat(3500),
        createdAtUnix: 1700000500,
        url: 'https://x.com/xss_nft/status/1000',
        isReply: false,
        inReplyToTweetId: null,
        inReplyToHandle: null,
        retweetedTweet: null,
        quotedTweet: null,
        expandedUrls: [],
      },
      signal: {
        priority: 'NORMAL',
        matchedKeywords: [],
        evmAddresses: [],
        links: [],
      },
    };
    const wallHtml = TelegramFormatter.formatTweetAlert(wallEvent);
    expect(wallHtml.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    assertNoUnpairedSurrogates(wallHtml);
    assertBalancedHtmlTags(wallHtml);
  });

  it('blocks unsupported/malicious URL protocols in <a href> (ipfs://, javascript:, ens.eth, data:, >2KB URLs)', () => {
    expect(sanitizeTelegramHttpUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeTelegramHttpUrl('ipfs://QmHash12345')).toBeNull();
    expect(sanitizeTelegramHttpUrl('vitalik.eth')).toBeNull();
    expect(sanitizeTelegramHttpUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(sanitizeTelegramHttpUrl('http://localhost/mint')).toBeNull();
    expect(
      sanitizeTelegramHttpUrl(`https://example.com/?q=${'a'.repeat(2500)}`),
    ).toBeNull();
    expect(
      sanitizeTelegramHttpUrl('https://claim.manifold.xyz/drop?id=1&wl=true'),
    ).toBe('https://claim.manifold.xyz/drop?id=1&wl=true');

    // Card with ipfs:// websiteUrl -> renders <code>ipfs://...</code> without <a href="ipfs://...">
    const ipfsAccount: TrackedAccount = {
      ...sampleAccount,
      handle: 'displaced#12345',
      websiteUrl: 'ipfs://QmNftMetadataCid',
    };
    const cardHtml = TelegramFormatter.formatAccountCard(
      ipfsAccount,
      '✅ Добавлен',
    );
    expect(cardHtml).not.toContain('href="ipfs://');
    expect(cardHtml).toContain('<code>ipfs://QmNftMetadataCid</code>');
    assertSafeTelegramHrefProtocols(cardHtml);
    assertBalancedHtmlTags(cardHtml);

    // Profile alert with javascript: and ipfs:// in avatarUrl/bannerUrl/websiteUrl/links
    const adversarialProfileEvent: ProfileAlertEvent = {
      account: sampleAccount,
      freshProfile: {
        userId: sampleAccount.userId,
        handle: 'new_handle',
        displayName: 'a < b & c > d "nft"',
        bio: 'Bio <3 <script>x</script>',
        websiteUrl: 'javascript:alert("xss")',
        avatarUrl: 'ipfs://QmNewAvatar',
        bannerUrl: 'ens.eth/banner',
        availability: 'available',
        unavailableReason: null,
      },
      diff: {
        hasChanges: true,
        priority: 'HIGH',
        changes: [
          {
            field: 'avatarUrl',
            before: 'javascript:alert(1)',
            after: 'ipfs://QmNewAvatar',
          },
          {
            field: 'bannerUrl',
            before: 'data:image/png;base64,AAA',
            after: 'vitalik.eth',
          },
          {
            field: 'websiteUrl',
            before: 'vitalik.eth',
            after: 'javascript:alert("xss")',
          },
        ],
        signal: {
          priority: 'HIGH',
          matchedKeywords: ['mint'],
          evmAddresses: [],
          links: [
            {
              url: 'ipfs://QmBadLinkInSignal',
              hostname: 'ipfs',
              category: 'other',
            },
          ],
        },
      },
      detectedAtUnix: Number.NaN, // Also verifies NaN timestamp safety!
    };

    const profileHtml = TelegramFormatter.formatProfileAlert(
      adversarialProfileEvent,
    );
    expect(profileHtml.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(profileHtml).not.toContain('href="javascript:');
    expect(profileHtml).not.toContain('href="ipfs:');
    expect(profileHtml).not.toContain('href="data:');
    expect(profileHtml).not.toContain('<script>');
    expect(profileHtml).toContain('неизвестно');
    assertSafeTelegramHrefProtocols(profileHtml);
    assertBalancedHtmlTags(profileHtml);

    // Massive keyword list (250 keywords) stays <= 4096 chars!
    const hugeKeywords = Array.from(
      { length: 250 },
      (_, i) => `trigger_keyword_number_${i}_nft_mint`,
    );
    const kwHtml = TelegramFormatter.formatKeywordsList(hugeKeywords);
    expect(kwHtml.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    assertBalancedHtmlTags(kwHtml);
  });

  it('formats profile "было → стало" alerts <= 4096 chars with balanced HTML', () => {
    const profileEvent: ProfileAlertEvent = {
      account: sampleAccount,
      freshProfile: {
        userId: sampleAccount.userId,
        handle: 'new_handle',
        displayName: 'New Name <b>bold</b>',
        bio: 'Huge new bio <x> '.repeat(300),
        websiteUrl: 'https://premint.xyz/new-drop',
        avatarUrl: 'https://pbs.twimg.com/profile_images/2/new_400x400.jpg',
        bannerUrl: null,
        availability: 'available',
        unavailableReason: null,
      },
      diff: {
        hasChanges: true,
        priority: 'HIGH',
        changes: [
          { field: 'handle', before: '@xss_nft', after: '@new_handle' },
          {
            field: 'bio',
            before: 'Old <bio> '.repeat(300),
            after: 'Huge new bio <x> '.repeat(300),
          },
          {
            field: 'websiteUrl',
            before: 'https://old.xyz',
            after: 'https://premint.xyz/new-drop',
          },
        ],
        signal: {
          priority: 'HIGH',
          matchedKeywords: ['premint'],
          evmAddresses: ['0xED5AF388653567Af2F388E6224dC7C4b3241C544'],
          links: [
            {
              url: 'https://premint.xyz/new-drop',
              hostname: 'premint.xyz',
              category: 'raffle',
            },
          ],
        },
      },
      detectedAtUnix: 1700001000,
    };

    const html = TelegramFormatter.formatProfileAlert(profileEvent);
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(html).toContain('Было:');
    expect(html).toContain('Стало:');
    expect(html).toContain(
      '<code>0xED5AF388653567Af2F388E6224dC7C4b3241C544</code>',
    );
    assertBalancedHtmlTags(html);
  });

  it('keeps callback_data payloads strictly within Telegram 64-byte limit', () => {
    const maxUint64 = '18446744073709551615';
    const data = encodeCallbackData(`r:${maxUint64}:99`);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);

    expect(() => encodeCallbackData('x'.repeat(65))).toThrow();
  });

  it('retries Telegram 429 flood-control, 502 server errors, and transient network drops via createTelegramRetryTransformer', async () => {
    const sleptMs: number[] = [];
    const fakeClock: Clock = {
      nowMs: () => 0,
      nowUnix: () => 0,
      sleep: async (ms) => {
        sleptMs.push(ms);
      },
    };
    const noopLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => noopLogger,
    };

    const transformer = createTelegramRetryTransformer(fakeClock, noopLogger, {
      maxRetries: 3,
      extraBufferMs: 250,
      serverErrorBaseDelayMs: 1000,
    });

    let calls = 0;
    const fakePrev = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false as const,
          error_code: 429,
          description: 'Too Many Requests: retry after 4',
          parameters: { retry_after: 4 },
        };
      }
      if (calls === 2) {
        return {
          ok: false as const,
          error_code: 502,
          description: 'Bad Gateway',
        };
      }
      if (calls === 3) {
        throw new Error('fetch failed: ECONNRESET');
      }
      return {
        ok: true as const,
        result: true as never,
      };
    };

    const response = await transformer(
      fakePrev as Parameters<typeof transformer>[0],
      'sendMessage',
      { chat_id: 1, text: 'hi' } as never,
      undefined,
    );

    expect(response.ok).toBe(true);
    expect(calls).toBe(4);
    expect(sleptMs).toEqual([4250, 2250, 4000]);
  });
});
