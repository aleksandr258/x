import type { TwitterUserProfile } from '../../domain/entities/account.js';
import type { NormalizedTweet } from '../../domain/entities/tweet.js';

export type RequestPriority = 'HIGH' | 'NORMAL';

export interface TweetSearchPage {
  readonly tweets: readonly NormalizedTweet[];
  readonly hasNextPage: boolean;
  readonly nextCursor: string | null;
}

export interface TwitterProviderHealthSnapshot {
  readonly mode: 'LIVE' | 'MOCK';
  readonly totalRequests: number;
  readonly rateLimitHits: number;
  readonly lastError: string | null;
  readonly lastErrorAtUnix: number | null;
  readonly lastRequestAtUnix: number | null;
  readonly queuedHigh: number;
  readonly queuedNormal: number;
}

export interface TwitterProvider {
  readonly mode: 'LIVE' | 'MOCK';

  getUserByHandle(
    handle: string,
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<TwitterUserProfile | null>;

  getUsersByIds(
    userIds: readonly string[],
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<readonly TwitterUserProfile[]>;

  searchRecentTweets(params: {
    query: string;
    cursor?: string | null;
    priority?: RequestPriority;
    signal?: AbortSignal;
  }): Promise<TweetSearchPage>;

  getHealthSnapshot(): TwitterProviderHealthSnapshot;
}
