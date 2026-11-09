export type AccountAvailability = 'available' | 'unavailable';

export interface TrackedAccount {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly includeReplies: boolean;
  readonly enabled: boolean;
  readonly availability: AccountAvailability;
  readonly unavailableReason: string | null;
  readonly consecutiveMisses: number;
  readonly baselineAt: number;
  readonly lastTweetSeenAt: number | null;
  readonly lastProfileCheckedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TwitterUserProfile {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly websiteUrl: string | null;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly followersCount?: number | null;
  readonly availability: AccountAvailability;
  readonly unavailableReason: string | null;
}
