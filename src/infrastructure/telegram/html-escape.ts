export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_MAX_HREF_BYTES = 2048;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * Replaces any lone unpaired UTF-16 surrogates with U+FFFD so outbound JSON/UTF-8
 * payloads never trigger Telegram HTTP 400 encoding errors.
 */
export function toWellFormedUnicode(raw: string): string {
  const len = raw.length;
  if (len === 0) {
    return '';
  }

  let hasLoneSurrogate = false;
  for (let i = 0; i < len; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < len ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        hasLoneSurrogate = true;
        break;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      hasLoneSurrogate = true;
      break;
    }
  }

  if (!hasLoneSurrogate) {
    return raw;
  }

  let out = '';
  for (let i = 0; i < len; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < len ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += raw.slice(i, i + 2);
        i += 1;
      } else {
        out += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += raw[i]!;
    }
  }
  return out;
}

/**
 * Strictly escapes dynamic untrusted strings for Telegram HTML parse_mode.
 */
export function escapeHtml(raw: string): string {
  if (raw.length === 0) {
    return '';
  }
  return toWellFormedUnicode(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Clamps a plain string by grapheme clusters AND UTF-16 code-unit budget so:
 * 1) Surrogate pairs (emoji like 🔥, 🚀) and ZWJ sequences (👨‍💻) are NEVER split in half.
 * 2) Resulting JS UTF-16 `.length` never exceeds `maxUnits` even on emoji-heavy strings.
 */
export function clampPlainText(raw: string, maxUnits: number): string {
  const safeMax = Math.max(1, Math.floor(maxUnits));
  const clean = toWellFormedUnicode(raw);
  if (clean.length <= safeMax) {
    return clean;
  }
  if (safeMax === 1) {
    return '…';
  }

  const budget = safeMax - 1;
  let result = '';
  let count = 0;

  for (const { segment } of GRAPHEME_SEGMENTER.segment(clean)) {
    if (count >= budget || result.length + segment.length > budget) {
      break;
    }
    result += segment;
    count += 1;
  }

  return `${result}…`;
}

/**
 * Clamps raw text FIRST, then escapes HTML entities so neither HTML entities
 * nor surrounding HTML tags can ever be broken by truncation.
 */
export function escapeAndClampHtml(raw: string, maxUnits: number): string {
  return escapeHtml(clampPlainText(raw, maxUnits));
}

/**
 * Validates and normalizes an untrusted URL for Telegram `<a href="...">`.
 * Telegram HTML links ONLY support `http://` and `https://` URLs with valid hostnames.
 * Rejects `javascript:`, `ipfs:`, `data:`, bare ENS names (`foo.eth`), and oversized URLs.
 */
export function sanitizeTelegramHttpUrl(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) {
    return null;
  }
  const trimmed = toWellFormedUnicode(rawUrl).trim();
  if (trimmed.length === 0 || /[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname;
  if (host.length === 0 || (!host.includes('.') && !host.startsWith('['))) {
    return null;
  }

  const normalized = parsed.toString();
  if (Buffer.byteLength(normalized, 'utf8') > TELEGRAM_MAX_HREF_BYTES) {
    return null;
  }

  return normalized;
}

/**
 * Escapes a URL for safe placement inside an HTML `<a href="...">` attribute.
 */
export function escapeHtmlAttributeUrl(rawUrl: string): string {
  return escapeHtml(rawUrl.trim());
}

/**
 * Renders `<a href="...">labelHtml</a>` ONLY if `rawUrl` is a valid http(s) URL
 * accepted by Telegram; otherwise renders `fallbackHtml ?? labelHtml` safely.
 */
export function renderSafeHtmlLink(
  rawUrl: string | null | undefined,
  labelHtml: string,
  fallbackHtml?: string,
): string {
  const safeUrl = sanitizeTelegramHttpUrl(rawUrl);
  if (safeUrl === null) {
    return fallbackHtml ?? labelHtml;
  }
  return `<a href="${escapeHtmlAttributeUrl(safeUrl)}">${labelHtml}</a>`;
}

/**
 * Converts formatted Telegram HTML into clean plain text clamped to `maxUnits`
 * for emergency fallback delivery if Telegram ever rejects an HTML entity payload.
 */
export function stripHtmlToPlainText(
  html: string,
  maxUnits: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string {
  const withoutTags = toWellFormedUnicode(html).replace(/<[^>]*>/g, '');
  const decoded = withoutTags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return clampPlainText(decoded, maxUnits);
}

/**
 * Final hard invariant guard ensuring any outgoing HTML string is strictly <= 4096
 * UTF-16 code units with zero broken tags or broken entities.
 */
export function ensureMaxTelegramHtmlLength(html: string): string {
  const clean = toWellFormedUnicode(html);
  if (clean.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return clean;
  }

  let plainBudget = TELEGRAM_MAX_MESSAGE_LENGTH - 256;
  while (plainBudget >= 64) {
    const fallback = escapeHtml(stripHtmlToPlainText(clean, plainBudget));
    if (fallback.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return fallback;
    }
    plainBudget = Math.floor(plainBudget / 2);
  }

  return escapeHtml(stripHtmlToPlainText(clean, 64));
}
