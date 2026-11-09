import { DEFAULT_TRIGGER_KEYWORDS } from '../../domain/services/nft-signal-analyzer.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  KeywordRepository,
  SyncStateRepository,
} from '../ports/repositories.js';

const DEFAULTS_SEEDED_KEY = 'defaults_seeded';
const MAX_KEYWORD_LENGTH = 64;

export interface AddKeywordsResult {
  readonly addedCount: number;
  readonly normalizedKeywords: readonly string[];
  readonly totalKeywords: number;
}

export interface RemoveKeywordResult {
  readonly removed: boolean;
  readonly keyword: string;
  readonly totalKeywords: number;
}

export class KeywordManagementService {
  public constructor(
    private readonly keywordRepo: KeywordRepository,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  public ensureDefaultsSeeded(): void {
    const alreadySeeded = this.syncStateRepo.get(DEFAULTS_SEEDED_KEY);
    if (alreadySeeded === '1') {
      return;
    }

    const nowUnix = this.clock.nowUnix();
    const inserted = this.keywordRepo.addMany(DEFAULT_TRIGGER_KEYWORDS, nowUnix);
    this.syncStateRepo.set(DEFAULTS_SEEDED_KEY, '1', nowUnix);

    this.logger.info('Seeded default NFT trigger keywords', {
      inserted,
      defaultsCount: DEFAULT_TRIGGER_KEYWORDS.length,
    });
  }

  public listKeywords(): string[] {
    return this.keywordRepo.listAll();
  }

  public countKeywords(): number {
    return this.keywordRepo.count();
  }

  public addKeywordsFromInput(rawInput: string): AddKeywordsResult {
    const candidates = rawInput
      .split(/[,\n]+/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0 && part.length <= MAX_KEYWORD_LENGTH);

    const uniqueNormalized = Array.from(new Set(candidates));
    if (uniqueNormalized.length === 0) {
      return {
        addedCount: 0,
        normalizedKeywords: [],
        totalKeywords: this.keywordRepo.count(),
      };
    }

    const addedCount = this.keywordRepo.addMany(
      uniqueNormalized,
      this.clock.nowUnix(),
    );

    this.logger.info('Added NFT trigger keywords', {
      keywords: uniqueNormalized,
      addedCount,
    });

    return {
      addedCount,
      normalizedKeywords: uniqueNormalized,
      totalKeywords: this.keywordRepo.count(),
    };
  }

  public removeKeywordFromInput(rawInput: string): RemoveKeywordResult {
    const normalized = rawInput.trim().toLowerCase();
    if (normalized.length === 0) {
      return {
        removed: false,
        keyword: '',
        totalKeywords: this.keywordRepo.count(),
      };
    }

    const removed = this.keywordRepo.remove(normalized);
    if (removed) {
      this.logger.info('Removed NFT trigger keyword', { keyword: normalized });
    }

    return {
      removed,
      keyword: normalized,
      totalKeywords: this.keywordRepo.count(),
    };
  }
}
