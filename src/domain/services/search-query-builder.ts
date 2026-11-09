export interface SearchQueryBatch {
  readonly handles: readonly string[];
  readonly query: string;
}

export interface SearchQueryBuilderOptions {
  readonly maxHandlesPerBatch?: number;
  readonly maxQueryLength?: number;
}

const DEFAULT_MAX_HANDLES_PER_BATCH = 20;
const DEFAULT_MAX_QUERY_LENGTH = 450;
const VALID_SEARCH_HANDLE_REGEX = /^[a-z0-9_]{1,15}$/;

export class SearchQueryBuilder {
  /**
   * Chunks active handles into Twitter advanced_search queries of the form:
   * `(from:h1 OR from:h2) since_time:<sinceUnix>`
   *
   * Simultaneously enforces:
   * 1) `handles.length <= maxHandlesPerBatch` (default 20)
   * 2) `query.length <= maxQueryLength` (default 450 chars, safely below X's 512 limit)
   */
  public static buildBatches(
    rawHandles: readonly string[],
    sinceUnix: number,
    options: SearchQueryBuilderOptions = {},
  ): SearchQueryBatch[] {
    const maxHandles = Math.max(
      1,
      options.maxHandlesPerBatch ?? DEFAULT_MAX_HANDLES_PER_BATCH,
    );
    const maxQueryLength = Math.max(
      64,
      options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH,
    );
    const normalizedSince = Math.max(0, Math.floor(sinceUnix));

    const uniqueHandles = Array.from(
      new Set(
        rawHandles
          .map((h) => h.trim().replace(/^@+/, '').toLowerCase())
          .filter((h) => VALID_SEARCH_HANDLE_REGEX.test(h)),
      ),
    ).sort((a, b) => a.localeCompare(b));

    if (uniqueHandles.length === 0) {
      return [];
    }

    const batches: SearchQueryBatch[] = [];
    let currentHandles: string[] = [];

    for (const handle of uniqueHandles) {
      const candidateHandles = [...currentHandles, handle];
      const candidateQuery = this.formatQuery(candidateHandles, normalizedSince);

      const exceedsCount = candidateHandles.length > maxHandles;
      const exceedsLength = candidateQuery.length > maxQueryLength;

      if (currentHandles.length > 0 && (exceedsCount || exceedsLength)) {
        batches.push({
          handles: currentHandles,
          query: this.formatQuery(currentHandles, normalizedSince),
        });
        currentHandles = [handle];
      } else {
        currentHandles = candidateHandles;
      }
    }

    if (currentHandles.length > 0) {
      batches.push({
        handles: currentHandles,
        query: this.formatQuery(currentHandles, normalizedSince),
      });
    }

    return batches;
  }

  public static formatQuery(handles: readonly string[], sinceUnix: number): string {
    const clauses = handles.map((h) => `from:${h}`).join(' OR ');
    return `(${clauses}) since_time:${Math.max(0, Math.floor(sinceUnix))}`;
  }
}
