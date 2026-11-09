import { describe, expect, it } from 'vitest';
import type { NormalizedTweet } from '../../src/domain/entities/tweet.js';
import {
  DEFAULT_TRIGGER_KEYWORDS,
  NftSignalAnalyzer,
} from '../../src/domain/services/nft-signal-analyzer.js';

describe('NftSignalAnalyzer', () => {
  it('matches English and Cyrillic keywords on Unicode word boundaries without substring false positives', () => {
    const keywords = [...DEFAULT_TRIGGER_KEYWORDS, 'минт', 'фриминт'];

    expect(
      NftSignalAnalyzer.matchKeywords(
        'Eating a bowl of cereal while slowly walking, delivered today.',
        keywords,
      ),
    ).toEqual([]);

    expect(
      NftSignalAnalyzer.matchKeywords(
        '🔥 #WL phase is LIVE! Минт открыт!',
        keywords,
      ),
    ).toEqual(['live', 'wl', 'минт']);
  });

  it('extracts EIP-55 EVM addresses while ignoring 64-char transaction hashes', () => {
    const checksummed = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
    const lowerUrl = `https://opensea.io/assets/ethereum/${checksummed.toLowerCase()}`;
    const txHash =
      '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

    const addresses = NftSignalAnalyzer.extractEvmAddresses([
      lowerUrl,
      `Contract: ${checksummed} | Tx: ${txHash}`,
    ]);

    expect(addresses).toEqual([checksummed]);
  });

  it('extracts and categorizes Web3 links from text and quoted/retweeted tweets while ignoring x.com links', () => {
    const tweet: NormalizedTweet = {
      id: '1001',
      authorId: '42',
      authorHandle: 'nftproject',
      authorDisplayName: 'NFT Project',
      text: 'Genesis drop! Join https://discord.gg/abc123 and check https://mint.nftproject.xyz).',
      createdAtUnix: 1_700_000_000,
      url: 'https://x.com/nftproject/status/1001',
      isReply: false,
      inReplyToTweetId: null,
      inReplyToHandle: null,
      retweetedTweet: null,
      quotedTweet: {
        id: '1000',
        authorId: '42',
        authorHandle: 'nftproject',
        authorDisplayName: 'NFT Project',
        text: 'Raffle on Premint + Launchpad',
        expandedUrls: [
          'https://www.premint.xyz/nftproject/',
          'https://claim.manifold.xyz/nftproject',
          'https://pro.opensea.io/collection/nftproject',
          'https://x.com/nftproject/status/1000/photo/1',
        ],
        url: 'https://x.com/nftproject/status/1000',
      },
      expandedUrls: ['https://t.co/short'],
    };

    const signal = NftSignalAnalyzer.analyzeTweet(
      tweet,
      DEFAULT_TRIGGER_KEYWORDS,
    );

    expect(signal.priority).toBe('HIGH');
    expect(signal.matchedKeywords).toContain('premint');
    expect(signal.matchedKeywords).toContain('raffle');

    const byCategory = Object.fromEntries(
      signal.links.map((l) => [l.category, l.hostname]),
    );
    expect(byCategory).toEqual({
      discord: 'discord.gg',
      other: 'mint.nftproject.xyz',
      raffle: 'www.premint.xyz',
      launchpad: 'claim.manifold.xyz',
      marketplace: 'pro.opensea.io',
    });
  });

  it('assigns NORMAL priority to ordinary posts with no NFT triggers, contracts, or Web3 links', () => {
    const signal = NftSignalAnalyzer.analyzeTextAndUrls(
      ['GM everyone, hope you have a great Tuesday! ☕'],
      [],
      DEFAULT_TRIGGER_KEYWORDS,
    );

    expect(signal.priority).toBe('NORMAL');
    expect(signal.matchedKeywords).toEqual([]);
    expect(signal.evmAddresses).toEqual([]);
    expect(signal.links).toEqual([]);
  });
});
