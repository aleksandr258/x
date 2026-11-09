import { describe, expect, it } from 'vitest';
import type { TrackedAccount } from '../../src/domain/entities/account.js';
import type { NormalizedTweet } from '../../src/domain/entities/tweet.js';
import { TweetClassifier } from '../../src/domain/services/tweet-classifier.js';

function makeAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    userId: '101',
    handle: 'azuki',
    displayName: 'Azuki',
    bio: '',
    websiteUrl: null,
    avatarUrl: null,
    bannerUrl: null,
    includeReplies: false,
    enabled: true,
    availability: 'available',
    unavailableReason: null,
    consecutiveMisses: 0,
    baselineAt: 1_700_000_000,
    lastTweetSeenAt: null,
    lastProfileCheckedAt: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

function makeTweet(overrides: Partial<NormalizedTweet> = {}): NormalizedTweet {
  return {
    id: 't1',
    authorId: '101',
    authorHandle: 'azuki',
    authorDisplayName: 'Azuki',
    text: 'Hello Garden!',
    createdAtUnix: 1_700_000_100,
    url: 'https://x.com/azuki/status/t1',
    isReply: false,
    inReplyToTweetId: null,
    inReplyToHandle: null,
    retweetedTweet: null,
    quotedTweet: null,
    expandedUrls: [],
    ...overrides,
  };
}

describe('TweetClassifier', () => {
  it('classifies POST, QUOTE, REPLY, and RETWEET accurately', () => {
    expect(TweetClassifier.classify(makeTweet())).toBe('POST');

    expect(
      TweetClassifier.classify(
        makeTweet({
          quotedTweet: {
            id: 'q1',
            authorId: '202',
            authorHandle: 'other',
            authorDisplayName: 'Other',
            text: 'Quoted',
            expandedUrls: [],
            url: 'https://x.com/other/status/q1',
          },
        }),
      ),
    ).toBe('QUOTE');

    expect(
      TweetClassifier.classify(
        makeTweet({ isReply: true, inReplyToTweetId: 'p1', inReplyToHandle: 'user' }),
      ),
    ).toBe('REPLY');

    expect(
      TweetClassifier.classify(makeTweet({ text: 'RT @yugalabs: Big drop soon' })),
    ).toBe('RETWEET');
  });

  it('filters out tweets older than account baselineAt and disabled replies', () => {
    const account = makeAccount({ baselineAt: 1_700_000_500, includeReplies: false });

    expect(
      TweetClassifier.evaluateEligibility(
        makeTweet({ createdAtUnix: 1_700_000_499 }),
        account,
      ),
    ).toEqual({
      notify: false,
      kind: 'POST',
      skipReason: 'BEFORE_BASELINE',
    });

    const replyTweet = makeTweet({
      createdAtUnix: 1_700_000_600,
      isReply: true,
      inReplyToTweetId: '999',
    });

    expect(TweetClassifier.evaluateEligibility(replyTweet, account)).toEqual({
      notify: false,
      kind: 'REPLY',
      skipReason: 'REPLY_DISABLED',
    });

    expect(
      TweetClassifier.evaluateEligibility(replyTweet, {
        ...account,
        includeReplies: true,
      }),
    ).toEqual({
      notify: true,
      kind: 'REPLY',
    });
  });
});
