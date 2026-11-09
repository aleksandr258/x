import { describe, expect, it } from 'vitest';
import { SearchQueryBuilder } from '../../src/domain/services/search-query-builder.js';

describe('SearchQueryBuilder', () => {
  it('returns empty array when no handles are supplied', () => {
    expect(SearchQueryBuilder.buildBatches([], 1_700_000_000)).toEqual([]);
  });

  it('normalizes, deduplicates, sorts handles, and formats query string', () => {
    const batches = SearchQueryBuilder.buildBatches(
      ['@Zora', 'azuki', 'boredapeyc', 'AZUKI'],
      1_700_000_123,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      handles: ['azuki', 'boredapeyc', 'zora'],
      query: '(from:azuki OR from:boredapeyc OR from:zora) since_time:1700000123',
    });
  });

  it('chunks batches when handle count exceeds maxHandlesPerBatch', () => {
    const handles = Array.from({ length: 25 }, (_, i) => `nft_acct_${i + 1}`);
    const batches = SearchQueryBuilder.buildBatches(handles, 1_700_000_000, {
      maxHandlesPerBatch: 20,
      maxQueryLength: 450,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.handles).toHaveLength(20);
    expect(batches[1]?.handles).toHaveLength(5);
    for (const batch of batches) {
      expect(batch.query.length).toBeLessThanOrEqual(450);
    }
  });

  it('enforces maxQueryLength even before reaching maxHandlesPerBatch', () => {
    // 15-char handles: "from:abcdefghijklmno OR " = 24 chars each; 20 of them > 450 chars!
    const longHandles = Array.from(
      { length: 22 },
      (_, idx) => `longhandle_${String(idx + 1).padStart(4, '0')}`,
    );

    const batches = SearchQueryBuilder.buildBatches(longHandles, 1_762_610_000, {
      maxHandlesPerBatch: 25,
      maxQueryLength: 450,
    });

    expect(batches.length).toBeGreaterThan(1);
    const reconstructed = batches.flatMap((b) => b.handles);
    expect(reconstructed).toHaveLength(22);

    for (const batch of batches) {
      expect(batch.query.length).toBeLessThanOrEqual(450);
      expect(batch.query).toContain('since_time:1762610000');
    }
  });

  it('strips displaced collision placeholder handles (e.g. handle#userId) and malformed handles so queries never break', () => {
    const batches = SearchQueryBuilder.buildBatches(
      ['azuki', 'azuki#222', 'bad space', 'toolong_handle_16c', '@pudgypenguins'],
      1_762_610_000,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]?.handles).toEqual(['azuki', 'pudgypenguins']);
    expect(batches[0]?.query).toBe(
      '(from:azuki OR from:pudgypenguins) since_time:1762610000',
    );
  });
});
