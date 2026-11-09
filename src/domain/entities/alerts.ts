import type { TrackedAccount, TwitterUserProfile } from './account.js';
import type { ProfileDiffResult } from './profile-diff.js';
import type { NftSignalAnalysis } from './signal.js';
import type { NormalizedTweet, TweetKind } from './tweet.js';

export interface TweetAlertEvent {
  readonly account: TrackedAccount;
  readonly tweet: NormalizedTweet;
  readonly kind: TweetKind;
  readonly signal: NftSignalAnalysis;
  readonly isSimulated?: boolean;
}

export interface ProfileAlertEvent {
  readonly account: TrackedAccount;
  readonly freshProfile: TwitterUserProfile;
  readonly diff: ProfileDiffResult;
  readonly detectedAtUnix: number;
  readonly isSimulated?: boolean;
}

export interface SystemAlertEvent {
  readonly level: 'WARN' | 'ERROR';
  readonly title: string;
  readonly message: string;
  readonly statusCode?: number;
  readonly occurredAtUnix: number;
}
