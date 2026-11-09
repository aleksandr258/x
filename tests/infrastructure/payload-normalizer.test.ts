import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/application/ports/clock.js';
import type { Logger } from '../../src/application/ports/logger.js';
import { MockTwitterProvider } from '../../src/infrastructure/twitter/mock-twitter-provider.js';
import { PayloadNormalizer } from '../../src/infrastructure/twitter/payload-normalizer.js';
import { RateLimitedHttpClient } from '../../src/infrastructure/twitter/rate-limited-http-client.js';
import { TwitterApiIoProvider } from '../../src/infrastructure/twitter/twitter-api-io-provider.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe('PayloadNormalizer', () => {
  it('normalizes TwitterAPI.io user/info response and unwraps t.co links in bio & website', () => {
    const rawResponse = {
      status: 'success',
      msg: 'success',
      data: {
        type: 'user',
        id: '1499990001',
        userName: 'Azuki',
        name: 'Azuki',
        description: 'Enter the Garden: https://t.co/garden123',
        url: 'https://t.co/site456',
        profilePicture:
          'https://pbs.twimg.com/profile_images/1499990001/avatar_normal.png?tag=1',
        coverPicture:
          'https://pbs.twimg.com/profile_banners/1499990001/1700000000/1500x500',
        followers: 642000,
        entities: {
          description: {
            urls: [
              {
                url: 'https://t.co/garden123',
                expanded_url: 'https://azuki.com/garden',
              },
            ],
          },
          url: {
            urls: [
              {
                url: 'https://t.co/site456',
                expanded_url: 'https://azuki.com',
              },
            ],
          },
        },
      },
    };

    const profile = PayloadNormalizer.normalizeSingleUserResponse(rawResponse);
    expect(profile).toEqual({
      userId: '1499990001',
      handle: 'azuki',
      displayName: 'Azuki',
      bio: 'Enter the Garden: https://azuki.com/garden',
      websiteUrl: 'https://azuki.com',
      avatarUrl:
        'https://pbs.twimg.com/profile_images/1499990001/avatar_400x400.png',
      bannerUrl: 'https://pbs.twimg.com/profile_banners/1499990001/1700000000',
      followersCount: 642000,
      availability: 'available',
      unavailableReason: null,
    });
  });

  it('normalizes batch_info_by_ids including unavailable/suspended user stubs', () => {
    const rawBatch = {
      status: 'success',
      users: [
        {
          id: '100',
          userName: 'active_nft',
          name: 'Active NFT',
          description: 'Minting soon',
          url: '',
        },
        {
          id: '200',
          userName: 'suspended_nft',
          unavailable: true,
          unavailableReason: 'User has been suspended',
        },
      ],
    };

    const profiles = PayloadNormalizer.normalizeBatchUsersResponse(rawBatch);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.availability).toBe('available');
    expect(profiles[1]).toEqual({
      userId: '200',
      handle: 'suspended_nft',
      displayName: '',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      followersCount: null,
      availability: 'unavailable',
      unavailableReason: 'User has been suspended',
    });
  });

  it('normalizes advanced_search tweets with RFC2822 timestamps, note_tweet text, t.co unwrapping, and quotes', () => {
    const rawSearch = {
      tweets: [
        {
          id: '1888000111222',
          text: 'Short preview https://t.co/mintlink',
          note_tweet: {
            text: 'Full X Premium announcement! Official Mint: https://t.co/mintlink Contract: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
          },
          createdAt: 'Sun Nov 08 12:00:00 +0000 2026',
          isReply: false,
          author: {
            id: '1499990001',
            userName: 'Azuki',
            name: 'Azuki',
          },
          entities: {
            urls: [
              {
                url: 'https://t.co/mintlink',
                expanded_url: 'https://claim.manifold.xyz/azuki',
              },
            ],
          },
          quoted_tweet: {
            id: '1888000000001',
            text: 'Snapshot taken!',
            author: {
              id: '1499990001',
              userName: 'Azuki',
              name: 'Azuki',
            },
            entities: { urls: [] },
          },
        },
      ],
      has_next_page: true,
      next_cursor: 'DAACCgACGKi123',
    };

    const page = PayloadNormalizer.normalizeSearchTweetsResponse(
      rawSearch,
      1_700_000_000,
    );

    expect(page.hasNextPage).toBe(true);
    expect(page.nextCursor).toBe('DAACCgACGKi123');
    expect(page.tweets).toHaveLength(1);

    const tweet = page.tweets[0]!;
    expect(tweet.id).toBe('1888000111222');
    expect(tweet.authorHandle).toBe('azuki');
    expect(tweet.text).toContain('https://claim.manifold.xyz/azuki');
    expect(tweet.text).toContain('0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
    expect(tweet.expandedUrls).toEqual(['https://claim.manifold.xyz/azuki']);
    expect(tweet.quotedTweet?.text).toBe('Snapshot taken!');
    expect(tweet.createdAtUnix).toBe(
      Math.floor(Date.parse('Sun Nov 08 12:00:00 +0000 2026') / 1000),
    );
  });

  it('preserves 64-bit Snowflake ID precision via id_str/rest_id when lossy float id is also present and rejects non-http tweet URLs', () => {
    const exactSnowflake = '1854999999999999999';
    // Number('1854999999999999999') rounds to 1855000000000000000 in IEEE-754 float!
    const lossyNumericId = 1854999999999999999;

    const page = PayloadNormalizer.normalizeSearchTweetsResponse(
      {
        tweets: [
          {
            id: lossyNumericId,
            id_str: exactSnowflake,
            text: 'Snowflake precision test',
            url: 'javascript:alert(1)',
            createdAt: 1_762_610_000,
            author: {
              id: lossyNumericId,
              rest_id: '1499999999999999997',
              userName: 'Azuki',
              name: 'Azuki',
            },
          },
        ],
      },
      1_762_610_000,
    );

    expect(page.tweets).toHaveLength(1);
    const tweet = page.tweets[0]!;
    expect(tweet.id).toBe(exactSnowflake);
    expect(tweet.authorId).toBe('1499999999999999997');
    expect(tweet.url).toBe(`https://x.com/azuki/status/${exactSnowflake}`);
  });

  it('chunks TwitterApiIoProvider.getUsersByIds requests at <= 100 IDs per HTTP call and bounds MockTwitterProvider maps', async () => {
    const clock = new SystemClock();
    const requestedUrls: string[] = [];

    const httpClient = new RateLimitedHttpClient(clock, silentLogger, {
      minIntervalMs: 0,
      timeoutMs: 5_000,
      maxRetries: 0,
      fetchFn: async (url) => {
        requestedUrls.push(String(url));
        const parsed = new URL(String(url));
        const ids = (parsed.searchParams.get('userIds') ?? '')
          .split(',')
          .filter(Boolean);
        return new Response(
          JSON.stringify({
            status: 'success',
            users: ids.map((id) => ({
              id,
              userName: `u_${id}`,
              name: `User ${id}`,
              description: '',
              url: '',
            })),
          }),
          { status: 200 },
        );
      },
    });

    const provider = new TwitterApiIoProvider(httpClient, clock, {
      baseUrl: 'https://api.twitterapi.io',
      apiKey: 'test-key',
    });

    const ids135 = Array.from({ length: 135 }, (_, idx) => String(10_000 + idx));
    const profiles = await provider.getUsersByIds(ids135);

    expect(requestedUrls).toHaveLength(2);
    const batch1Ids = new URL(requestedUrls[0]!).searchParams
      .get('userIds')!
      .split(',');
    const batch2Ids = new URL(requestedUrls[1]!).searchParams
      .get('userIds')!
      .split(',');
    expect(batch1Ids).toHaveLength(100);
    expect(batch2Ids).toHaveLength(35);
    expect(profiles).toHaveLength(135);

    // Verify MockTwitterProvider bounds synthetic tweets to <= 500
    const mock = new MockTwitterProvider(clock, { autoEvents: true });
    for (let i = 0; i < 550; i += 1) {
      await mock.searchRecentTweets({ query: '(from:azuki) since_time:0' });
    }
    const page = await mock.searchRecentTweets({ query: '(from:azuki) since_time:0' });
    expect(page.tweets.length).toBeLessThanOrEqual(500);
  });
});
