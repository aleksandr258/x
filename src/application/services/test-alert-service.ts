import type {
  TrackedAccount,
  TwitterUserProfile,
} from '../../domain/entities/account.js';
import type { NormalizedTweet } from '../../domain/entities/tweet.js';
import {
  DEFAULT_TRIGGER_KEYWORDS,
  NftSignalAnalyzer,
} from '../../domain/services/nft-signal-analyzer.js';
import { ProfileDiffEngine } from '../../domain/services/profile-diff-engine.js';
import type { AlertNotifier } from '../ports/alert-notifier.js';
import type { Clock } from '../ports/clock.js';
import type { KeywordRepository } from '../ports/repositories.js';

export class TestAlertService {
  public constructor(
    private readonly alertNotifier: AlertNotifier,
    private readonly keywordRepo: KeywordRepository,
    private readonly clock: Clock,
  ) {}

  public async sendSimulatedAlerts(): Promise<void> {
    const nowUnix = this.clock.nowUnix();
    const configuredKeywords = this.keywordRepo.listAll();
    const keywords =
      configuredKeywords.length > 0
        ? configuredKeywords
        : DEFAULT_TRIGGER_KEYWORDS;

    const sampleAccount: TrackedAccount = {
      userId: '999000111222',
      handle: 'project_alpha',
      displayName: 'Project Alpha NFT',
      bio: 'Building next-gen on-chain art. Soon.',
      websiteUrl: null,
      avatarUrl: 'https://pbs.twimg.com/profile_images/1000/avatar_400x400.jpg',
      bannerUrl: 'https://pbs.twimg.com/profile_banners/1000/1700000000',
      includeReplies: false,
      enabled: true,
      availability: 'available',
      unavailableReason: null,
      consecutiveMisses: 0,
      baselineAt: nowUnix - 3600,
      lastTweetSeenAt: nowUnix - 600,
      lastProfileCheckedAt: nowUnix - 180,
      createdAt: nowUnix - 86400,
      updatedAt: nowUnix - 180,
    };

    const sampleTweet: NormalizedTweet = {
      id: `sim_${nowUnix}`,
      authorId: sampleAccount.userId,
      authorHandle: sampleAccount.handle,
      authorDisplayName: sampleAccount.displayName,
      text: [
        '🔥 GENESIS MINT IS OFFICIALLY LIVE! WL & Public phase open now.',
        '',
        'Official Contract: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
        'Claim here: https://claim.manifold.xyz/project-alpha',
        'Secondary: https://opensea.io/collection/project-alpha',
        'Join Discord: https://discord.gg/projectalpha',
      ].join('\n'),
      createdAtUnix: nowUnix,
      url: `https://x.com/${sampleAccount.handle}/status/1900000000000000001`,
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: null,
      expandedUrls: [
        'https://claim.manifold.xyz/project-alpha',
        'https://opensea.io/collection/project-alpha',
        'https://discord.gg/projectalpha',
      ],
    };

    const tweetSignal = NftSignalAnalyzer.analyzeTweet(sampleTweet, keywords);
    await this.alertNotifier.sendTweetAlert({
      account: sampleAccount,
      tweet: sampleTweet,
      kind: 'POST',
      signal: tweetSignal,
      isSimulated: true,
    });

    const updatedProfile: TwitterUserProfile = {
      userId: sampleAccount.userId,
      handle: 'project_mint',
      displayName: 'Project Alpha (MINT LIVE 🟢)',
      bio: 'Genesis Mint LIVE! Allowlist claim open. Contract: 0xED5AF388653567Af2F388E6224dC7C4b3241C544',
      websiteUrl: 'https://mint.projectalpha.xyz',
      avatarUrl: 'https://pbs.twimg.com/profile_images/2000/new_avatar_400x400.jpg',
      bannerUrl: sampleAccount.bannerUrl,
      availability: 'available',
      unavailableReason: null,
    };

    const profileDiff = ProfileDiffEngine.diff(
      sampleAccount,
      updatedProfile,
      keywords,
    );

    await this.alertNotifier.sendProfileAlert({
      account: sampleAccount,
      freshProfile: updatedProfile,
      diff: profileDiff,
      detectedAtUnix: nowUnix,
      isSimulated: true,
    });
  }
}
