const TWITTER_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

const RESERVED_ROUTES = new Set([
  'home',
  'explore',
  'search',
  'settings',
  'i',
  'intent',
  'share',
  'messages',
  'notifications',
  'compose',
  'tos',
  'privacy',
  'login',
  'logout',
  'signup',
  'hashtag',
  'lists',
  'bookmarks',
  'communities',
  'jobs',
  'grok',
  'premium',
]);

const HANDLE_REGEX = /^[A-Za-z0-9_]{1,15}$/;

export type HandleParseErrorReason =
  | 'EMPTY'
  | 'INVALID_DOMAIN'
  | 'RESERVED_ROUTE'
  | 'INVALID_FORMAT';

export type HandleParseResult =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly reason: HandleParseErrorReason };

export class HandleParser {
  /**
   * Parses an X/Twitter handle or profile/status URL into a canonical lowercase handle.
   * Supports:
   * - `@boredapeyc`
   * - `boredapeyc`
   * - `https://x.com/BoredApeYC`
   * - `https://twitter.com/BoredApeYC/status/123456?s=20`
   * - `x.com/BoredApeYC`
   */
  public static parse(rawInput: string): HandleParseResult {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'EMPTY' };
    }

    if (this.looksLikeUrlOrDomain(trimmed)) {
      return this.parseUrlInput(trimmed);
    }

    const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    if (stripped.length === 0) {
      return { ok: false, reason: 'EMPTY' };
    }

    return this.validateCandidate(stripped);
  }

  /**
   * Checks whether a plain-text chat message is an explicit `@handle` or X/Twitter URL
   * suitable for frictionless auto-add in Telegram without colliding with normal text.
   */
  public static parseDirectMessageInput(rawText: string): HandleParseResult | null {
    const trimmed = rawText.trim();
    if (trimmed.length === 0 || trimmed.startsWith('/') || /\s/.test(trimmed)) {
      return null;
    }

    if (trimmed.startsWith('@')) {
      return this.parse(trimmed);
    }

    if (/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(trimmed)) {
      return this.parse(trimmed);
    }

    return null;
  }

  private static looksLikeUrlOrDomain(value: string): boolean {
    return (
      /^https?:\/\//i.test(value) ||
      value.includes('/') ||
      value.includes('.')
    );
  }

  private static parseUrlInput(input: string): HandleParseResult {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(withProtocol);
    } catch {
      return { ok: false, reason: 'INVALID_FORMAT' };
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (!TWITTER_HOSTS.has(hostname)) {
      return { ok: false, reason: 'INVALID_DOMAIN' };
    }

    const segments = parsedUrl.pathname
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const firstSegment = segments[0];
    if (firstSegment === undefined) {
      return { ok: false, reason: 'EMPTY' };
    }

    const candidate = firstSegment.startsWith('@')
      ? firstSegment.slice(1)
      : firstSegment;

    return this.validateCandidate(candidate);
  }

  private static validateCandidate(candidate: string): HandleParseResult {
    const lower = candidate.toLowerCase();
    if (RESERVED_ROUTES.has(lower)) {
      return { ok: false, reason: 'RESERVED_ROUTE' };
    }

    if (!HANDLE_REGEX.test(candidate)) {
      return { ok: false, reason: 'INVALID_FORMAT' };
    }

    return { ok: true, handle: lower };
  }
}
