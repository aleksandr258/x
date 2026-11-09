import type { Clock } from '../../application/ports/clock.js';
import type {
  RequestPriority,
  TweetSearchPage,
  TwitterProvider,
  TwitterProviderHealthSnapshot,
} from '../../application/ports/twitter-provider.js';
import type { TwitterUserProfile } from '../../domain/entities/account.js';
import type { NormalizedTweet } from '../../domain/entities/tweet.js';

export interface MockTwitterProviderOptions {
  readonly autoEvents?: boolean;
}

const SEEDED_PROFILES: readonly TwitterUserProfile[] = [
  {
    userId: '100001',
    handle: 'boredapeyc',
    displayName: 'Bored Ape Yacht Club',
    bio: 'Official BAYC X account. Yuga Labs ecosystem.',
    websiteUrl: 'https://boredapeyachtclub.com',
    avatarUrl: 'https://pbs.twimg.com/profile_images/100001/bayc_400x400.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/100001/1700000001',
    followersCount: 985_000,
    availability: 'available',
    unavailableReason: null,
  },
  {
    userId: '100002',
    handle: 'azuki',
    displayName: 'Azuki',
    bio: 'Enter the Garden. Building an open anime universe.',
    websiteUrl: 'https://azuki.com',
    avatarUrl: 'https://pbs.twimg.com/profile_images/100002/azuki_400x400.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/100002/1700000002',
    followersCount: 640_000,
    availability: 'available',
    unavailableReason: null,
  },
  {
    userId: '100003',
    handle: 'pudgypenguins',
    displayName: 'Pudgy Penguins',
    bio: 'Spreading good vibes across Web3 & beyond.',
    websiteUrl: 'https://pudgypenguins.com',
    avatarUrl: 'https://pbs.twimg.com/profile_images/100003/pudgy_400x400.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/100003/1700000003',
    followersCount: 520_000,
    availability: 'available',
    unavailableReason: null,
  },
  {
    userId: '100004',
    handle: 'artblocks_io',
    displayName: 'Art Blocks',
    bio: 'Generative art stored immutably on Ethereum.',
    websiteUrl: 'https://artblocks.io',
    avatarUrl: 'https://pbs.twimg.com/profile_images/100004/ab_400x400.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/100004/1700000004',
    followersCount: 210_000,
    availability: 'available',
    unavailableReason: null,
  },
];

const MAX_MOCK_TWEETS = 500;
const MAX_MOCK_USERS = 1_000;
const SEEDED_USER_IDS = new Set(SEEDED_PROFILES.map((p) => p.userId));

export class MockTwitterProvider implements TwitterProvider {
  public readonly mode = 'MOCK' as const;

  private readonly usersById = new Map<string, TwitterUserProfile>();
  private readonly tweetsById = new Map<string, NormalizedTweet>();
  private totalRequests = 0;
  private lastRequestAtUnix: number | null = null;
  private syntheticSeq = 1;
  private readonly autoEvents: boolean;

  public constructor(
    private readonly clock: Clock,
    options: MockTwitterProviderOptions = {},
  ) {
    this.autoEvents = options.autoEvents ?? false;
    for (const profile of SEEDED_PROFILES) {
      this.usersById.set(profile.userId, profile);
    }
  }

  public seedUser(profile: TwitterUserProfile): void {
    this.setUserBounded(profile.userId, {
      ...profile,
      handle: profile.handle.toLowerCase(),
    });
  }

  public removeUser(userId: string): void {
    this.usersById.delete(userId);
  }

  public pushTweet(tweet: NormalizedTweet): void {
    this.setTweetBounded(tweet.id, tweet);
  }

  public async getUserByHandle(
    handle: string,
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<TwitterUserProfile | null> {
    this.recordCall(options?.signal);
    const normalized = handle.trim().replace(/^@+/, '').toLowerCase();

    if (normalized === 'notfound_mock_user') {
      return null;
    }

    for (const existing of this.usersById.values()) {
      if (existing.handle.toLowerCase() === normalized) {
        return existing;
      }
    }

    // Deterministically synthesize a realistic NFT account profile for any valid handle
    const syntheticId = this.deterministicUserId(normalized);
    const created: TwitterUserProfile = {
      userId: syntheticId,
      handle: normalized,
      displayName: `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} NFT`,
      bio: `Official X account for @${normalized}. Digital collectibles & Web3.`,
      websiteUrl: `https://${normalized}.xyz`,
      avatarUrl: `https://pbs.twimg.com/profile_images/${syntheticId}/avatar_400x400.jpg`,
      bannerUrl: `https://pbs.twimg.com/profile_banners/${syntheticId}/1700000000`,
      followersCount: 12_500,
      availability: 'available',
      unavailableReason: null,
    };
    this.setUserBounded(syntheticId, created);
    return created;
  }

  public async getUsersByIds(
    userIds: readonly string[],
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<readonly TwitterUserProfile[]> {
    this.recordCall(options?.signal);

    if (this.autoEvents && userIds.length > 0 && this.syntheticSeq % 3 === 0) {
      const targetId = userIds[0];
      const existing = targetId ? this.usersById.get(targetId) : undefined;
      if (existing && existing.availability === 'available') {
        const seq = this.syntheticSeq++;
        this.usersById.set(existing.userId, {
          ...existing,
          bio: `🔥 Stealth Mint Phase #${seq} is LIVE! WL claim open now.`,
          websiteUrl: `https://claim.manifold.xyz/${existing.handle}-${seq}`,
        });
      }
    }

    const found: TwitterUserProfile[] = [];
    for (const id of userIds) {
      const profile = this.usersById.get(id);
      if (profile !== undefined) {
        found.push(profile);
      }
    }
    return found;
  }

  public async searchRecentTweets(params: {
    query: string;
    cursor?: string | null;
    priority?: RequestPriority;
    signal?: AbortSignal;
  }): Promise<TweetSearchPage> {
    this.recordCall(params.signal);

    const { handles, sinceUnix } = this.parseSearchQuery(params.query);

    if (this.autoEvents && handles.size > 0) {
      const firstHandle = Array.from(handles)[0];
      if (firstHandle) {
        this.emitSyntheticTweetForHandle(firstHandle);
      }
    }

    const matching = Array.from(this.tweetsById.values())
      .filter((tweet) => {
        const matchesAuthor =
          handles.size === 0 || handles.has(tweet.authorHandle.toLowerCase());
        const matchesSince = tweet.createdAtUnix >= sinceUnix;
        return matchesAuthor && matchesSince;
      })
      .sort((a, b) => b.createdAtUnix - a.createdAtUnix);

    return {
      tweets: matching,
      hasNextPage: false,
      nextCursor: null,
    };
  }

  public getHealthSnapshot(): TwitterProviderHealthSnapshot {
    return {
      mode: 'MOCK',
      totalRequests: this.totalRequests,
      rateLimitHits: 0,
      lastError: null,
      lastErrorAtUnix: null,
      lastRequestAtUnix: this.lastRequestAtUnix,
      queuedHigh: 0,
      queuedNormal: 0,
    };
  }

  private emitSyntheticTweetForHandle(handle: string): void {
    const author = Array.from(this.usersById.values()).find(
      (u) => u.handle.toLowerCase() === handle.toLowerCase(),
    );
    if (!author) {
      return;
    }

    const nowUnix = this.clock.nowUnix();
    const seq = this.syntheticSeq++;
    const tweetId = `mock_tweet_${nowUnix}_${seq}`;
    const mintUrl = `https://zora.co/collect/eth:0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/${seq}`;

    this.setTweetBounded(tweetId, {
      id: tweetId,
      authorId: author.userId,
      authorHandle: author.handle,
      authorDisplayName: author.displayName,
      text: `🚨 Drop #${seq} Mint is LIVE! Allowlist & Public open.\nContract: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D\nMint: ${mintUrl}`,
      createdAtUnix: nowUnix,
      url: `https://x.com/${author.handle}/status/${tweetId}`,
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [mintUrl],
    });
  }

  private setTweetBounded(id: string, tweet: NormalizedTweet): void {
    if (this.tweetsById.has(id)) {
      this.tweetsById.delete(id);
    }
    this.tweetsById.set(id, tweet);
    while (this.tweetsById.size > MAX_MOCK_TWEETS) {
      const oldestKey = this.tweetsById.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.tweetsById.delete(oldestKey);
    }
  }

  private setUserBounded(userId: string, profile: TwitterUserProfile): void {
    if (this.usersById.has(userId)) {
      this.usersById.delete(userId);
    }
    this.usersById.set(userId, profile);
    if (this.usersById.size <= MAX_MOCK_USERS) {
      return;
    }
    for (const key of this.usersById.keys()) {
      if (this.usersById.size <= MAX_MOCK_USERS) {
        break;
      }
      if (!SEEDED_USER_IDS.has(key) && key !== userId) {
        this.usersById.delete(key);
      }
    }
  }

  private parseSearchQuery(query: string): {
    handles: Set<string>;
    sinceUnix: number;
  } {
    const handles = new Set<string>();
    const fromMatches = query.matchAll(/from:([A-Za-z0-9_]{1,15})/gi);
    for (const match of fromMatches) {
      const h = match[1];
      if (h) {
        handles.add(h.toLowerCase());
      }
    }

    const sinceMatch = /since_time:(\d+)/i.exec(query);
    const sinceUnix =
      sinceMatch && sinceMatch[1] ? Number.parseInt(sinceMatch[1], 10) : 0;

    return { handles, sinceUnix };
  }

  private deterministicUserId(handle: string): string {
    let hash = 2166136261;
    for (let i = 0; i < handle.length; i += 1) {
      hash ^= handle.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return String(200_000_000 + (hash >>> 0));
  }

  private recordCall(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('Mock request aborted');
      err.name = 'AbortError';
      throw err;
    }
    this.totalRequests += 1;
    this.lastRequestAtUnix = this.clock.nowUnix();
  }
}
