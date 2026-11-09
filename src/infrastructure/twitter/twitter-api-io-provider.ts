import type { Clock } from '../../application/ports/clock.js';
import type {
  RequestPriority,
  TweetSearchPage,
  TwitterProvider,
  TwitterProviderHealthSnapshot,
} from '../../application/ports/twitter-provider.js';
import type { TwitterUserProfile } from '../../domain/entities/account.js';
import { TwitterProviderHttpError } from './errors.js';
import { PayloadNormalizer } from './payload-normalizer.js';
import type { RateLimitedHttpClient } from './rate-limited-http-client.js';

export interface TwitterApiIoProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

const MAX_BATCH_USER_IDS = 100;

export class TwitterApiIoProvider implements TwitterProvider {
  public readonly mode = 'LIVE' as const;
  private readonly baseUrl: string;

  public constructor(
    private readonly httpClient: RateLimitedHttpClient,
    private readonly clock: Clock,
    private readonly config: TwitterApiIoProviderConfig,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  public async getUserByHandle(
    handle: string,
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<TwitterUserProfile | null> {
    const cleanHandle = handle.trim().replace(/^@+/, '');
    const url = new URL(`${this.baseUrl}/twitter/user/info`);
    url.searchParams.set('userName', cleanHandle);

    try {
      const payload = await this.httpClient.getJson(url.toString(), {
        priority: options?.priority ?? 'HIGH',
        headers: this.authHeaders(),
        signal: options?.signal,
      });

      return PayloadNormalizer.normalizeSingleUserResponse(payload);
    } catch (err) {
      if (err instanceof TwitterProviderHttpError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  public async getUsersByIds(
    userIds: readonly string[],
    options?: { priority?: RequestPriority; signal?: AbortSignal },
  ): Promise<readonly TwitterUserProfile[]> {
    const cleanedIds = Array.from(
      new Set(userIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    );
    if (cleanedIds.length === 0) {
      return [];
    }

    const merged: TwitterUserProfile[] = [];
    for (let i = 0; i < cleanedIds.length; i += MAX_BATCH_USER_IDS) {
      const chunk = cleanedIds.slice(i, i + MAX_BATCH_USER_IDS);
      const url = new URL(`${this.baseUrl}/twitter/user/batch_info_by_ids`);
      url.searchParams.set('userIds', chunk.join(','));

      const payload = await this.httpClient.getJson(url.toString(), {
        priority: options?.priority ?? 'NORMAL',
        headers: this.authHeaders(),
        signal: options?.signal,
      });

      merged.push(...PayloadNormalizer.normalizeBatchUsersResponse(payload));
    }

    return merged;
  }

  public async searchRecentTweets(params: {
    query: string;
    cursor?: string | null;
    priority?: RequestPriority;
    signal?: AbortSignal;
  }): Promise<TweetSearchPage> {
    const url = new URL(`${this.baseUrl}/twitter/tweet/advanced_search`);
    url.searchParams.set('query', params.query);
    url.searchParams.set('queryType', 'Latest');
    if (params.cursor && params.cursor.trim().length > 0) {
      url.searchParams.set('cursor', params.cursor.trim());
    }

    const payload = await this.httpClient.getJson(url.toString(), {
      priority: params.priority ?? 'NORMAL',
      headers: this.authHeaders(),
      signal: params.signal,
    });

    return PayloadNormalizer.normalizeSearchTweetsResponse(
      payload,
      this.clock.nowUnix(),
    );
  }

  public getHealthSnapshot(): TwitterProviderHealthSnapshot {
    const metrics = this.httpClient.getMetrics();
    return {
      mode: 'LIVE',
      ...metrics,
    };
  }

  private authHeaders(): Readonly<Record<string, string>> {
    return {
      'X-API-Key': this.config.apiKey,
    };
  }
}
