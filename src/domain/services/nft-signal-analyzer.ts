import type {
  AlertPriority,
  CategorizedLink,
  NftSignalAnalysis,
  Web3LinkCategory,
} from '../entities/signal.js';
import type { NormalizedTweet } from '../entities/tweet.js';

export const DEFAULT_TRIGGER_KEYWORDS: readonly string[] = [
  'mint',
  'live',
  'wl',
  'allowlist',
  'whitelist',
  'premint',
  'raffle',
  'claim',
  'snapshot',
  'presale',
  'airdrop',
  'reveal',
];

const EVM_ADDRESS_REGEX = /(?<![a-fA-F0-9xX])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
const RAW_URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

const IGNORED_TWITTER_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  't.co',
  'pbs.twimg.com',
  'video.twimg.com',
  'abs.twimg.com',
  'pic.x.com',
  'pic.twitter.com',
]);

const MARKETPLACE_DOMAINS = [
  'opensea.io',
  'blur.io',
  'magiceden.io',
  'magiceden.us',
  'magiceden.com',
  'tensor.trade',
  'rarible.com',
  'element.market',
  'superrare.com',
];

const LAUNCHPAD_DOMAINS = [
  'manifold.xyz',
  'zora.co',
  'highlight.xyz',
  'foundation.app',
  'scatter.art',
  'mint.fun',
  'sound.xyz',
  'transientlabs.xyz',
];

const RAFFLE_DOMAINS = [
  'premint.xyz',
  'alphabot.app',
  'heymint.xyz',
  'atlas3.io',
  'subber.xyz',
  'guild.xyz',
  'galxe.com',
  'zealy.io',
];

export class NftSignalAnalyzer {
  /**
   * Analyzes a normalized tweet (including referenced retweet/quote content and unwrapped URLs)
   * for NFT mint/allowlist signals, EVM smart contracts, and Web3 links.
   */
  public static analyzeTweet(
    tweet: NormalizedTweet,
    keywords: readonly string[],
  ): NftSignalAnalysis {
    const texts: string[] = [tweet.text];
    const candidateUrls: string[] = [...tweet.expandedUrls];

    if (tweet.retweetedTweet !== null) {
      texts.push(tweet.retweetedTweet.text);
      candidateUrls.push(...tweet.retweetedTweet.expandedUrls);
    }

    if (tweet.quotedTweet !== null) {
      texts.push(tweet.quotedTweet.text);
      candidateUrls.push(...tweet.quotedTweet.expandedUrls);
    }

    return this.analyzeTextAndUrls(texts, candidateUrls, keywords);
  }

  /**
   * Core signal analyzer shared by both Tweet and Profile Diff analyzers.
   */
  public static analyzeTextAndUrls(
    texts: readonly string[],
    candidateUrls: readonly string[],
    keywords: readonly string[],
  ): NftSignalAnalysis {
    const combinedText = texts.filter((t) => t.length > 0).join('\n');

    const matchedKeywords = this.matchKeywords(combinedText, keywords);
    const links = this.extractAndCategorizeLinks(texts, candidateUrls);
    const evmAddresses = this.extractEvmAddresses([
      ...texts,
      ...links.map((l) => l.url),
    ]);

    const hasRecognizedWeb3Link = links.some((link) => link.category !== 'other');
    const priority: AlertPriority =
      evmAddresses.length > 0 ||
      matchedKeywords.length > 0 ||
      hasRecognizedWeb3Link
        ? 'HIGH'
        : 'NORMAL';

    return {
      priority,
      matchedKeywords,
      evmAddresses,
      links,
    };
  }

  public static matchKeywords(
    text: string,
    keywords: readonly string[],
  ): string[] {
    if (text.trim().length === 0 || keywords.length === 0) {
      return [];
    }

    const normalizedKeywords = Array.from(
      new Set(
        keywords
          .map((kw) => kw.trim().toLowerCase())
          .filter((kw) => kw.length > 0),
      ),
    );

    const matched: string[] = [];
    for (const keyword of normalizedKeywords) {
      const escaped = this.escapeRegExp(keyword);
      const regex = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
        'iu',
      );
      if (regex.test(text)) {
        matched.push(keyword);
      }
    }

    return matched;
  }

  /**
   * Extracts 42-char EVM addresses (`0x` + 40 hex chars) without matching 64-char tx hashes.
   * Deduplicates case-insensitively while preserving the first EIP-55 mixed-case representation.
   */
  public static extractEvmAddresses(sources: readonly string[]): string[] {
    const byLower = new Map<string, string>();

    for (const source of sources) {
      if (source.length === 0) {
        continue;
      }
      const matches = source.matchAll(EVM_ADDRESS_REGEX);
      for (const match of matches) {
        const address = match[0];
        const lower = address.toLowerCase();
        const existing = byLower.get(lower);
        if (existing === undefined) {
          byLower.set(lower, address);
        } else if (existing === lower && address !== lower) {
          // Upgrade all-lowercase URL occurrence to mixed-case EIP-55 checksum if seen later
          byLower.set(lower, address);
        }
      }
    }

    return Array.from(byLower.values());
  }

  public static extractAndCategorizeLinks(
    texts: readonly string[],
    candidateUrls: readonly string[],
  ): CategorizedLink[] {
    const rawPool: string[] = [...candidateUrls];

    for (const text of texts) {
      if (text.length === 0) {
        continue;
      }
      const matches = text.matchAll(RAW_URL_REGEX);
      for (const match of matches) {
        rawPool.push(this.stripTrailingUrlPunctuation(match[0]));
      }
    }

    const deduplicated = new Map<string, CategorizedLink>();

    for (const raw of rawPool) {
      const cleaned = this.stripTrailingUrlPunctuation(raw.trim());
      if (cleaned.length === 0) {
        continue;
      }

      let parsed: URL;
      try {
        parsed = new URL(cleaned);
      } catch {
        continue;
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        continue;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (IGNORED_TWITTER_HOSTS.has(hostname)) {
        continue;
      }

      const dedupKey = this.buildUrlDedupKey(parsed);
      if (deduplicated.has(dedupKey)) {
        continue;
      }

      deduplicated.set(dedupKey, {
        url: parsed.toString(),
        hostname,
        category: this.categorizeUrl(parsed, hostname),
      });
    }

    return Array.from(deduplicated.values());
  }

  private static categorizeUrl(parsed: URL, hostname: string): Web3LinkCategory {
    if (
      hostname === 'discord.gg' ||
      ((hostname === 'discord.com' ||
        hostname === 'www.discord.com' ||
        hostname === 'discordapp.com') &&
        parsed.pathname.toLowerCase().startsWith('/invite'))
    ) {
      return 'discord';
    }

    if (this.matchesDomainList(hostname, RAFFLE_DOMAINS)) {
      return 'raffle';
    }

    if (this.matchesDomainList(hostname, LAUNCHPAD_DOMAINS)) {
      return 'launchpad';
    }

    if (this.matchesDomainList(hostname, MARKETPLACE_DOMAINS)) {
      return 'marketplace';
    }

    return 'other';
  }

  private static matchesDomainList(
    hostname: string,
    domains: readonly string[],
  ): boolean {
    return domains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  }

  private static stripTrailingUrlPunctuation(url: string): string {
    let result = url;
    while (/[.,;:!?'"\]}>]$/.test(result)) {
      result = result.slice(0, -1);
    }
    // Strip unbalanced trailing closing parenthesis (e.g. "(https://mint.xyz)")
    while (result.endsWith(')')) {
      const openCount = (result.match(/\(/g) ?? []).length;
      const closeCount = (result.match(/\)/g) ?? []).length;
      if (closeCount > openCount) {
        result = result.slice(0, -1);
      } else {
        break;
      }
    }
    return result;
  }

  private static buildUrlDedupKey(parsed: URL): string {
    const pathname =
      parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  }

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
