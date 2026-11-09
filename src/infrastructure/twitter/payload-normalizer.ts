import type { TweetSearchPage } from '../../application/ports/twitter-provider.js';
import type { TwitterUserProfile } from '../../domain/entities/account.js';
import type {
  NormalizedTweet,
  ReferencedTweet,
} from '../../domain/entities/tweet.js';
import { ProfileDiffEngine } from '../../domain/services/profile-diff-engine.js';

type JsonRecord = Record<string, unknown>;

interface UrlEntityPair {
  readonly shortUrl: string;
  readonly expandedUrl: string;
}

export class PayloadNormalizer {
  /**
   * Normalizes single-user response from `GET /twitter/user/info`.
   */
  public static normalizeSingleUserResponse(
    payload: unknown,
  ): TwitterUserProfile | null {
    if (!isRecord(payload)) {
      return null;
    }

    const status = readString(payload, ['status']);
    if (status?.toLowerCase() === 'error') {
      return null;
    }

    const candidate = isRecord(payload['data'])
      ? payload['data']
      : isRecord(payload['user'])
        ? payload['user']
        : payload;

    return this.normalizeUserObject(candidate);
  }

  /**
   * Normalizes batch user response from `GET /twitter/user/batch_info_by_ids`.
   */
  public static normalizeBatchUsersResponse(
    payload: unknown,
  ): TwitterUserProfile[] {
    if (!isRecord(payload)) {
      return [];
    }

    let rawList: unknown[] = [];
    if (Array.isArray(payload['users'])) {
      rawList = payload['users'];
    } else if (isRecord(payload['data'])) {
      const dataObj = payload['data'];
      if (Array.isArray(dataObj['users'])) {
        rawList = dataObj['users'];
      }
    } else if (Array.isArray(payload['data'])) {
      rawList = payload['data'];
    }

    const normalized: TwitterUserProfile[] = [];
    for (const item of rawList) {
      if (!isRecord(item)) {
        continue;
      }
      const profile = this.normalizeUserObject(item);
      if (profile !== null) {
        normalized.push(profile);
      }
    }
    return normalized;
  }

  /**
   * Normalizes search response from `GET /twitter/tweet/advanced_search`.
   */
  public static normalizeSearchTweetsResponse(
    payload: unknown,
    fallbackNowUnix: number,
  ): TweetSearchPage {
    if (!isRecord(payload)) {
      return { tweets: [], hasNextPage: false, nextCursor: null };
    }

    const container =
      isRecord(payload['data']) && Array.isArray(payload['data']['tweets'])
        ? payload['data']
        : payload;

    const rawTweets = Array.isArray(container['tweets'])
      ? container['tweets']
      : [];

    const tweets: NormalizedTweet[] = [];
    for (const rawTweet of rawTweets) {
      if (!isRecord(rawTweet)) {
        continue;
      }
      const normalized = this.normalizeTweetObject(rawTweet, fallbackNowUnix);
      if (normalized !== null) {
        tweets.push(normalized);
      }
    }

    const hasNextPage =
      readBoolean(container, ['has_next_page', 'hasNextPage']) ??
      readBoolean(payload, ['has_next_page', 'hasNextPage']) ??
      false;

    const rawCursor =
      readString(container, ['next_cursor', 'nextCursor']) ??
      readString(payload, ['next_cursor', 'nextCursor']);
    const nextCursor =
      rawCursor && rawCursor.trim().length > 0 ? rawCursor.trim() : null;

    return {
      tweets,
      hasNextPage: hasNextPage && nextCursor !== null,
      nextCursor,
    };
  }

  public static normalizeUserObject(
    raw: JsonRecord,
  ): TwitterUserProfile | null {
    const userId = readIdString(raw, ['id', 'id_str', 'userId', 'rest_id']);
    if (!userId) {
      return null;
    }

    const isUnavailable =
      readBoolean(raw, ['unavailable', 'isUnavailable', 'suspended']) === true;

    const rawHandle =
      readString(raw, ['userName', 'username', 'screen_name', 'handle']) ?? '';
    const cleanHandle = rawHandle.trim().replace(/^@+/, '').toLowerCase();

    if (isUnavailable) {
      const reason =
        readString(raw, [
          'unavailableReason',
          'unavailable_reason',
          'message',
          'reason',
        ]) ?? 'Account unavailable';

      return {
        userId,
        handle: cleanHandle,
        displayName: readString(raw, ['name', 'displayName'])?.trim() ?? '',
        bio: '',
        websiteUrl: null,
        avatarUrl: null,
        bannerUrl: null,
        followersCount: readNumber(raw, ['followers', 'followers_count']),
        availability: 'unavailable',
        unavailableReason: reason,
      };
    }

    if (cleanHandle.length === 0) {
      return null;
    }

    const profileBioObj = isRecord(raw['profile_bio']) ? raw['profile_bio'] : null;
    const rawBio =
      readString(raw, ['description', 'bio']) ??
      (profileBioObj ? readString(profileBioObj, ['description']) : null) ??
      '';

    const bioUrlPairs = [
      ...this.extractNestedUrlPairs(raw, ['entities', 'description', 'urls']),
      ...this.extractNestedUrlPairs(raw, [
        'profile_bio',
        'entities',
        'description',
        'urls',
      ]),
    ];
    const unwrappedBio = this.replaceShortUrls(rawBio, bioUrlPairs);

    const websiteUrlPairs = [
      ...this.extractNestedUrlPairs(raw, ['entities', 'url', 'urls']),
      ...this.extractNestedUrlPairs(raw, [
        'profile_bio',
        'entities',
        'url',
        'urls',
      ]),
    ];

    const rawWebsite = readString(raw, ['url', 'website', 'websiteUrl']);
    let websiteUrl: string | null = null;
    if (websiteUrlPairs.length > 0 && websiteUrlPairs[0] !== undefined) {
      websiteUrl = websiteUrlPairs[0].expandedUrl;
    } else if (rawWebsite && rawWebsite.trim().length > 0) {
      websiteUrl = this.replaceShortUrls(rawWebsite.trim(), websiteUrlPairs);
    }

    const rawAvatar = readString(raw, [
      'profilePicture',
      'profile_image_url_https',
      'avatar',
      'avatarUrl',
    ]);
    const rawBanner = readString(raw, [
      'coverPicture',
      'profile_banner_url',
      'banner',
      'bannerUrl',
    ]);

    return {
      userId,
      handle: cleanHandle,
      displayName: readString(raw, ['name', 'displayName'])?.trim() ?? cleanHandle,
      bio: unwrappedBio.replace(/\r\n/g, '\n').trim(),
      websiteUrl: websiteUrl && websiteUrl.trim().length > 0 ? websiteUrl.trim() : null,
      avatarUrl: ProfileDiffEngine.normalizeAvatarUrl(rawAvatar),
      bannerUrl: ProfileDiffEngine.normalizeBannerUrl(rawBanner),
      followersCount: readNumber(raw, ['followers', 'followers_count']),
      availability: 'available',
      unavailableReason: null,
    };
  }

  public static normalizeTweetObject(
    raw: JsonRecord,
    fallbackNowUnix: number,
  ): NormalizedTweet | null {
    const id = readIdString(raw, ['id', 'id_str', 'tweetId', 'rest_id']);
    if (!id) {
      return null;
    }

    const authorObj = isRecord(raw['author'])
      ? raw['author']
      : isRecord(raw['user'])
        ? raw['user']
        : null;

    const authorId =
      (authorObj
        ? readIdString(authorObj, ['id', 'id_str', 'userId', 'rest_id'])
        : null) ??
      readIdString(raw, ['authorId', 'user_id_str', 'userId']) ??
      '';

    const rawAuthorHandle =
      (authorObj
        ? readString(authorObj, ['userName', 'username', 'screen_name'])
        : null) ??
      readString(raw, ['authorHandle', 'userName', 'screen_name']) ??
      '';
    const authorHandle = rawAuthorHandle.trim().replace(/^@+/, '').toLowerCase();

    if (authorId.length === 0 && authorHandle.length === 0) {
      return null;
    }

    const authorDisplayName =
      (authorObj ? readString(authorObj, ['name', 'displayName']) : null) ??
      authorHandle;

    const urlPairs = this.extractTweetUrlPairs(raw);
    const rawText = this.extractFullTweetText(raw);
    const unwrappedText = this.replaceShortUrls(rawText, urlPairs);

    const createdAtNumber = readNumber(raw, ['createdAt', 'created_at']);
    const createdAtRaw =
      readString(raw, ['createdAt', 'created_at']) ??
      (createdAtNumber !== null ? String(Math.trunc(createdAtNumber)) : null);
    const createdAtUnix = this.parseTimestampUnix(createdAtRaw, fallbackNowUnix);

    const handleForUrl = authorHandle.length > 0 ? authorHandle : 'i/web';
    const rawTweetUrl = readString(raw, ['url', 'twitterUrl'])?.trim();
    const canonicalUrl =
      rawTweetUrl && /^https?:\/\//i.test(rawTweetUrl)
        ? rawTweetUrl
        : `https://x.com/${handleForUrl}/status/${id}`;

    const inReplyToTweetId = readIdString(raw, [
      'inReplyToId',
      'in_reply_to_status_id_str',
      'in_reply_to_status_id',
      'inReplyToTweetId',
    ]);
    const inReplyToHandleRaw = readString(raw, [
      'inReplyToUsername',
      'inReplyToUserName',
      'in_reply_to_screen_name',
    ]);
    const inReplyToHandle = inReplyToHandleRaw
      ? inReplyToHandleRaw.trim().replace(/^@+/, '').toLowerCase()
      : null;

    const isReply =
      readBoolean(raw, ['isReply', 'is_reply']) === true ||
      inReplyToTweetId !== null;

    const rawRetweet = isRecord(raw['retweeted_tweet'])
      ? raw['retweeted_tweet']
      : isRecord(raw['retweetedTweet'])
        ? raw['retweetedTweet']
        : isRecord(raw['retweeted_status'])
          ? raw['retweeted_status']
          : null;

    const rawQuote = isRecord(raw['quoted_tweet'])
      ? raw['quoted_tweet']
      : isRecord(raw['quotedTweet'])
        ? raw['quotedTweet']
        : isRecord(raw['quoted_status'])
          ? raw['quoted_status']
          : null;

    const retweetedTweet = rawRetweet
      ? this.normalizeReferencedTweet(rawRetweet)
      : null;
    const quotedTweet = rawQuote ? this.normalizeReferencedTweet(rawQuote) : null;

    const expandedUrls = Array.from(
      new Set(
        urlPairs
          .map((pair) => pair.expandedUrl)
          .filter((u) => u.length > 0),
      ),
    );

    return {
      id,
      authorId,
      authorHandle,
      authorDisplayName: authorDisplayName.trim(),
      text: unwrappedText,
      createdAtUnix,
      url: canonicalUrl,
      isReply,
      inReplyToTweetId,
      inReplyToHandle,
      retweetedTweet,
      quotedTweet,
      expandedUrls,
    };
  }

  private static normalizeReferencedTweet(
    raw: JsonRecord,
  ): ReferencedTweet | null {
    const id = readIdString(raw, ['id', 'id_str', 'tweetId', 'rest_id']);
    if (!id) {
      return null;
    }

    const authorObj = isRecord(raw['author'])
      ? raw['author']
      : isRecord(raw['user'])
        ? raw['user']
        : null;

    const authorId = authorObj
      ? readIdString(authorObj, ['id', 'id_str', 'userId', 'rest_id'])
      : null;
    const authorHandleRaw = authorObj
      ? readString(authorObj, ['userName', 'username', 'screen_name'])
      : null;
    const authorHandle = authorHandleRaw
      ? authorHandleRaw.trim().replace(/^@+/, '').toLowerCase()
      : null;
    const authorDisplayName = authorObj
      ? readString(authorObj, ['name', 'displayName'])
      : null;

    const urlPairs = this.extractTweetUrlPairs(raw);
    const rawText = this.extractFullTweetText(raw);
    const text = this.replaceShortUrls(rawText, urlPairs);

    const rawRefUrl = readString(raw, ['url', 'twitterUrl'])?.trim();
    const url =
      rawRefUrl && /^https?:\/\//i.test(rawRefUrl)
        ? rawRefUrl
        : authorHandle
          ? `https://x.com/${authorHandle}/status/${id}`
          : null;

    return {
      id,
      authorId,
      authorHandle,
      authorDisplayName: authorDisplayName?.trim() ?? null,
      text,
      expandedUrls: Array.from(new Set(urlPairs.map((p) => p.expandedUrl))),
      url,
    };
  }

  private static extractFullTweetText(raw: JsonRecord): string {
    const noteTweet = isRecord(raw['note_tweet']) ? raw['note_tweet'] : null;
    const noteText = noteTweet ? readString(noteTweet, ['text']) : null;
    const primaryText =
      readString(raw, ['text', 'full_text', 'fullText']) ?? '';

    if (noteText && noteText.length > primaryText.length) {
      return noteText;
    }
    return primaryText;
  }

  private static extractTweetUrlPairs(raw: JsonRecord): UrlEntityPair[] {
    return [
      ...this.extractNestedUrlPairs(raw, ['entities', 'urls']),
      ...this.extractNestedUrlPairs(raw, ['extendedEntities', 'urls']),
      ...this.extractNestedUrlPairs(raw, ['legacy', 'entities', 'urls']),
    ];
  }

  private static extractNestedUrlPairs(
    root: JsonRecord,
    pathSegments: readonly string[],
  ): UrlEntityPair[] {
    let cursor: unknown = root;
    for (const seg of pathSegments) {
      if (!isRecord(cursor)) {
        return [];
      }
      cursor = cursor[seg];
    }

    if (!Array.isArray(cursor)) {
      return [];
    }

    const pairs: UrlEntityPair[] = [];
    for (const entry of cursor) {
      if (!isRecord(entry)) {
        continue;
      }
      const shortUrl = readString(entry, ['url']) ?? '';
      const expandedUrl =
        readString(entry, ['expanded_url', 'expandedUrl', 'unwound_url']) ?? '';
      if (expandedUrl.trim().length > 0) {
        pairs.push({
          shortUrl: shortUrl.trim(),
          expandedUrl: expandedUrl.trim(),
        });
      }
    }
    return pairs;
  }

  private static replaceShortUrls(
    text: string,
    pairs: readonly UrlEntityPair[],
  ): string {
    if (text.length === 0 || pairs.length === 0) {
      return text;
    }
    let updated = text;
    for (const pair of pairs) {
      if (pair.shortUrl.length > 0 && pair.expandedUrl.length > 0) {
        updated = updated.split(pair.shortUrl).join(pair.expandedUrl);
      }
    }
    return updated;
  }

  public static parseTimestampUnix(
    rawValue: string | null,
    fallbackUnix: number,
  ): number {
    if (!rawValue || rawValue.trim().length === 0) {
      return fallbackUnix;
    }

    const trimmed = rawValue.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      if (Number.isFinite(numeric) && numeric > 0) {
        // Distinguish milliseconds vs seconds
        return numeric > 10_000_000_000
          ? Math.floor(numeric / 1000)
          : numeric;
      }
    }

    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs) && parsedMs > 0) {
      return Math.floor(parsedMs / 1000);
    }

    return fallbackUnix;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string') {
      return val;
    }
  }
  return null;
}

function readIdString(obj: JsonRecord, keys: readonly string[]): string | null {
  // Prefer exact string IDs (e.g. 64-bit Snowflake id_str) across all candidate keys
  // before falling back to IEEE-754 numbers that lose precision above 2^53 - 1.
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return String(Math.trunc(val));
    }
  }
  return null;
}

function readBoolean(obj: JsonRecord, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'boolean') {
      return val;
    }
  }
  return null;
}

function readNumber(obj: JsonRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}
