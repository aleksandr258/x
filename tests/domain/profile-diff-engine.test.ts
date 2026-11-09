import { describe, expect, it } from 'vitest';
import type {
  TrackedAccount,
  TwitterUserProfile,
} from '../../src/domain/entities/account.js';
import { DEFAULT_TRIGGER_KEYWORDS } from '../../src/domain/services/nft-signal-analyzer.js';
import { ProfileDiffEngine } from '../../src/domain/services/profile-diff-engine.js';

function makeStoredAccount(
  overrides: Partial<TrackedAccount> = {},
): TrackedAccount {
  return {
    userId: '500',
    handle: 'stealth_art',
    displayName: 'Stealth Art',
    bio: 'Art collective on Ethereum.',
    websiteUrl: 'https://stealthart.io',
    avatarUrl: 'https://pbs.twimg.com/profile_images/99/pic_400x400.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/99/1700000000',
    includeReplies: false,
    enabled: true,
    availability: 'available',
    unavailableReason: null,
    consecutiveMisses: 0,
    baselineAt: 1_700_000_000,
    lastTweetSeenAt: null,
    lastProfileCheckedAt: 1_700_000_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

describe('ProfileDiffEngine', () => {
  it('ignores CDN avatar size suffix variations (_normal vs _400x400) and volatile query params', () => {
    const stored = makeStoredAccount();
    const fresh: TwitterUserProfile = {
      userId: '500',
      handle: 'Stealth_Art',
      displayName: 'Stealth Art ',
      bio: 'Art collective on Ethereum.\r\n',
      websiteUrl: 'https://stealthart.io/',
      avatarUrl: 'https://pbs.twimg.com/profile_images/99/pic_normal.jpg?name=orig',
      bannerUrl: 'https://pbs.twimg.com/profile_banners/99/1700000000/1500x500',
      availability: 'available',
      unavailableReason: null,
    };

    const diff = ProfileDiffEngine.diff(stored, fresh, DEFAULT_TRIGGER_KEYWORDS);
    expect(diff.hasChanges).toBe(false);
    expect(diff.changes).toEqual([]);
  });

  it('detects @handle rename, bio contract addition, and website change as HIGH priority', () => {
    const stored = makeStoredAccount();
    const fresh: TwitterUserProfile = {
      userId: '500',
      handle: 'stealth_mint',
      displayName: 'Stealth Mint LIVE',
      bio: 'Mint is LIVE! 0xED5AF388653567Af2F388E6224dC7C4b3241C544',
      websiteUrl: 'https://claim.manifold.xyz/stealth',
      avatarUrl: stored.avatarUrl,
      bannerUrl: stored.bannerUrl,
      availability: 'available',
      unavailableReason: null,
    };

    const diff = ProfileDiffEngine.diff(stored, fresh, DEFAULT_TRIGGER_KEYWORDS);
    expect(diff.hasChanges).toBe(true);
    expect(diff.priority).toBe('HIGH');
    expect(diff.changes.map((c) => c.field)).toEqual([
      'handle',
      'displayName',
      'bio',
      'websiteUrl',
    ]);
    expect(diff.changes[0]).toEqual({
      field: 'handle',
      before: '@stealth_art',
      after: '@stealth_mint',
    });
    expect(diff.signal.evmAddresses).toEqual([
      '0xED5AF388653567Af2F388E6224dC7C4b3241C544',
    ]);
    expect(diff.signal.matchedKeywords).toEqual(
      expect.arrayContaining(['mint', 'live']),
    );
  });

  it('emits clean availability-only HIGH diff when account becomes suspended/unavailable', () => {
    const stored = makeStoredAccount();
    const suspendedStub: TwitterUserProfile = {
      userId: '500',
      handle: 'stealth_art',
      displayName: '',
      bio: '',
      websiteUrl: null,
      avatarUrl: null,
      bannerUrl: null,
      availability: 'unavailable',
      unavailableReason: 'Suspended',
    };

    const diff = ProfileDiffEngine.diff(
      stored,
      suspendedStub,
      DEFAULT_TRIGGER_KEYWORDS,
    );
    expect(diff.hasChanges).toBe(true);
    expect(diff.priority).toBe('HIGH');
    expect(diff.changes).toEqual([
      {
        field: 'availability',
        before: 'available',
        after: 'unavailable (Suspended)',
      },
    ]);
  });
});
