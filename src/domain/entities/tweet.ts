export type TweetKind = 'POST' | 'QUOTE' | 'RETWEET' | 'REPLY';

export interface ReferencedTweet {
  readonly id: string;
  readonly authorId: string | null;
  readonly authorHandle: string | null;
  readonly authorDisplayName: string | null;
  readonly text: string;
  readonly expandedUrls: readonly string[];
  readonly url: string | null;
}

export interface NormalizedTweet {
  readonly id: string;
  readonly authorId: string;
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly text: string;
  readonly createdAtUnix: number;
  readonly url: string;
  readonly isReply: boolean;
  readonly inReplyToTweetId: string | null;
  readonly inReplyToHandle: string | null;
  readonly retweetedTweet: ReferencedTweet | null;
  readonly quotedTweet: ReferencedTweet | null;
  readonly expandedUrls: readonly string[];
}
