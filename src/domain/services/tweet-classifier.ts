import type { TrackedAccount } from '../entities/account.js';
import type { NormalizedTweet, TweetKind } from '../entities/tweet.js';

export type TweetSkipReason =
  | 'ACCOUNT_DISABLED'
  | 'BEFORE_BASELINE'
  | 'REPLY_DISABLED';

export interface TweetEligibilityResult {
  readonly notify: boolean;
  readonly kind: TweetKind;
  readonly skipReason?: TweetSkipReason;
}

export class TweetClassifier {
  /**
   * Classifies a tweet with strict precedence:
   * 1. RETWEET
   * 2. REPLY
   * 3. QUOTE
   * 4. POST
   */
  public static classify(tweet: NormalizedTweet): TweetKind {
    if (
      tweet.retweetedTweet !== null ||
      /^RT @[A-Za-z0-9_]{1,15}:/i.test(tweet.text.trimStart()) ||
      tweet.text.trimStart().startsWith('RT @')
    ) {
      return 'RETWEET';
    }

    if (tweet.isReply || tweet.inReplyToTweetId !== null) {
      return 'REPLY';
    }

    if (tweet.quotedTweet !== null) {
      return 'QUOTE';
    }

    return 'POST';
  }

  /**
   * Evaluates whether a tweet from a tracked account should trigger a Telegram alert.
   */
  public static evaluateEligibility(
    tweet: NormalizedTweet,
    account: TrackedAccount,
  ): TweetEligibilityResult {
    const kind = this.classify(tweet);

    if (!account.enabled) {
      return { notify: false, kind, skipReason: 'ACCOUNT_DISABLED' };
    }

    if (tweet.createdAtUnix < account.baselineAt) {
      return { notify: false, kind, skipReason: 'BEFORE_BASELINE' };
    }

    if (kind === 'REPLY' && !account.includeReplies) {
      return { notify: false, kind, skipReason: 'REPLY_DISABLED' };
    }

    return { notify: true, kind };
  }
}
