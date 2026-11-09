import type { TrackedAccount } from '../../domain/entities/account.js';
import type { NftSignalAnalysis } from '../../domain/entities/signal.js';
import type { NormalizedTweet, TweetKind } from '../../domain/entities/tweet.js';
import { NftSignalAnalyzer } from '../../domain/services/nft-signal-analyzer.js';
import { SearchQueryBuilder } from '../../domain/services/search-query-builder.js';
import { TweetClassifier } from '../../domain/services/tweet-classifier.js';
import {
  isNonRetryableDeliveryError,
  type AlertNotifier,
} from '../ports/alert-notifier.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  AccountRepository,
  KeywordRepository,
  SeenTweetRepository,
  SyncStateRepository,
} from '../ports/repositories.js';
import type { TwitterProvider } from '../ports/twitter-provider.js';

export const LAST_TWEET_POLL_UNIX_KEY = 'last_tweet_poll_unix';
const DEFAULT_MAX_ALERTS_PER_CYCLE = 50;

export interface TweetMonitorOptions {
  readonly overlapBufferSec: number;
  readonly coldStartLookbackSec: number;
  readonly maxLookbackSec: number;
  readonly maxHandlesPerBatch: number;
  readonly maxQueryLength: number;
  readonly maxPagesPerBatch: number;
  readonly maxAlertsPerCycle?: number;
}

export interface TweetPollCycleSummary {
  readonly skipped: boolean;
  readonly activeAccounts: number;
  readonly batchesQueried: number;
  readonly tweetsFetched: number;
  readonly unseenTweets: number;
  readonly alertsSent: number;
  readonly sinceUnix: number | null;
  readonly completedAtUnix: number;
}

interface PendingTweetNotification {
  readonly account: TrackedAccount;
  readonly tweet: NormalizedTweet;
  readonly kind: TweetKind;
  readonly signal: NftSignalAnalysis;
}

export class TweetMonitorService {
  private readonly maxAlertsPerCycle: number;

  public constructor(
    private readonly accountRepo: AccountRepository,
    private readonly seenTweetRepo: SeenTweetRepository,
    private readonly keywordRepo: KeywordRepository,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly twitterProvider: TwitterProvider,
    private readonly alertNotifier: AlertNotifier,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: TweetMonitorOptions,
  ) {
    this.maxAlertsPerCycle = Math.max(
      1,
      options.maxAlertsPerCycle ?? DEFAULT_MAX_ALERTS_PER_CYCLE,
    );
  }

  public async runCycle(signal?: AbortSignal): Promise<TweetPollCycleSummary> {
    const cycleStartUnix = this.clock.nowUnix();
    const activeAccounts = this.accountRepo.listActive();

    if (activeAccounts.length === 0) {
      this.logger.debug('Skipping tweet poll cycle: 0 active accounts');
      return {
        skipped: true,
        activeAccounts: 0,
        batchesQueried: 0,
        tweetsFetched: 0,
        unseenTweets: 0,
        alertsSent: 0,
        sinceUnix: null,
        completedAtUnix: cycleStartUnix,
      };
    }

    const byUserId = new Map<string, TrackedAccount>();
    const byHandle = new Map<string, TrackedAccount>();
    for (const account of activeAccounts) {
      byUserId.set(account.userId, account);
      byHandle.set(account.handle.toLowerCase(), account);
    }

    const sinceUnix = this.computeSinceUnix(cycleStartUnix);
    const batches = SearchQueryBuilder.buildBatches(
      activeAccounts.map((a) => a.handle),
      sinceUnix,
      {
        maxHandlesPerBatch: this.options.maxHandlesPerBatch,
        maxQueryLength: this.options.maxQueryLength,
      },
    );

    if (batches.length === 0) {
      this.logger.debug('Skipping tweet poll cycle: 0 valid search handles');
      return {
        skipped: true,
        activeAccounts: activeAccounts.length,
        batchesQueried: 0,
        tweetsFetched: 0,
        unseenTweets: 0,
        alertsSent: 0,
        sinceUnix: null,
        completedAtUnix: cycleStartUnix,
      };
    }

    const fetchedById = new Map<string, NormalizedTweet>();
    const cycleErrors: unknown[] = [];
    let batchesQueried = 0;

    for (const batch of batches) {
      this.throwIfAborted(signal);
      batchesQueried += 1;

      try {
        await this.fetchBatchPages(batch.query, fetchedById, signal);
      } catch (err) {
        if (signal?.aborted || this.isAbortError(err)) {
          throw err;
        }
        cycleErrors.push(err);
        this.logger.error('Failed to poll tweet search batch; preserving poll window for retry', {
          handlesCount: batch.handles.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allFetched = Array.from(fetchedById.values());
    const unseenIds = this.seenTweetRepo.filterUnseenIds(
      allFetched.map((t) => t.id),
    );
    const unseenTweets = allFetched
      .filter((t) => unseenIds.has(t.id))
      .sort((a, b) =>
        a.createdAtUnix !== b.createdAtUnix
          ? a.createdAtUnix - b.createdAtUnix
          : a.id.localeCompare(b.id),
      );

    const keywords = unseenTweets.length > 0 ? this.keywordRepo.listAll() : [];
    const eligible: PendingTweetNotification[] = [];

    for (const tweet of unseenTweets) {
      this.throwIfAborted(signal);

      const account =
        byUserId.get(tweet.authorId) ??
        byHandle.get(tweet.authorHandle.toLowerCase());

      if (account === undefined) {
        this.logger.debug('Ignoring tweet from non-tracked author in search result', {
          tweetId: tweet.id,
          authorId: tweet.authorId,
          authorHandle: tweet.authorHandle,
        });
        continue;
      }

      const seenAtUnix = this.clock.nowUnix();
      const eligibility = TweetClassifier.evaluateEligibility(tweet, account);

      if (!eligibility.notify) {
        this.seenTweetRepo.markSeen({
          tweetId: tweet.id,
          authorId: account.userId,
          createdAtUnix: tweet.createdAtUnix,
          seenAtUnix,
        });
        this.logger.debug('Filtered tweet without notification', {
          tweetId: tweet.id,
          handle: account.handle,
          kind: eligibility.kind,
          skipReason: eligibility.skipReason,
        });
        continue;
      }

      const signalAnalysis = NftSignalAnalyzer.analyzeTweet(tweet, keywords);
      eligible.push({
        account,
        tweet,
        kind: eligibility.kind,
        signal: signalAnalysis,
      });
    }

    const { selected, suppressed } = this.applyFloodCap(eligible);

    if (suppressed.length > 0) {
      const seenAtUnix = this.clock.nowUnix();
      this.seenTweetRepo.markSeenBatch(
        suppressed.map((item) => ({
          tweetId: item.tweet.id,
          authorId: item.account.userId,
          createdAtUnix: item.tweet.createdAtUnix,
          seenAtUnix,
        })),
      );
      this.logger.warn(
        'Tweet flood cap reached in poll cycle; suppressed older overflow tweets',
        {
          eligibleCount: eligible.length,
          deliveredBudget: selected.length,
          suppressedCount: suppressed.length,
          maxAlertsPerCycle: this.maxAlertsPerCycle,
        },
      );
    }

    let alertsSent = 0;
    const latestSeenByUser = new Map<string, number>();

    for (const item of selected) {
      this.throwIfAborted(signal);
      const seenAtUnix = this.clock.nowUnix();

      try {
        await this.alertNotifier.sendTweetAlert({
          account: item.account,
          tweet: item.tweet,
          kind: item.kind,
          signal: item.signal,
        });

        this.seenTweetRepo.markSeen({
          tweetId: item.tweet.id,
          authorId: item.account.userId,
          createdAtUnix: item.tweet.createdAtUnix,
          seenAtUnix,
        });

        const prevMax =
          latestSeenByUser.get(item.account.userId) ??
          item.account.lastTweetSeenAt ??
          0;
        const nextLastSeen = Math.max(prevMax, item.tweet.createdAtUnix);
        latestSeenByUser.set(item.account.userId, nextLastSeen);
        this.accountRepo.updateLastTweetSeenAt(item.account.userId, nextLastSeen);
        alertsSent += 1;
      } catch (err) {
        if (signal?.aborted || this.isAbortError(err)) {
          throw err;
        }

        if (isNonRetryableDeliveryError(err)) {
          this.seenTweetRepo.markSeen({
            tweetId: item.tweet.id,
            authorId: item.account.userId,
            createdAtUnix: item.tweet.createdAtUnix,
            seenAtUnix,
          });
          this.logger.error(
            'Non-retryable client error delivering tweet alert; marked seen to avoid infinite retry loop',
            {
              tweetId: item.tweet.id,
              handle: item.account.handle,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          continue;
        }

        cycleErrors.push(err);
        this.logger.error(
          'Transient error delivering tweet alert; leaving unseen for retry on next cycle',
          {
            tweetId: item.tweet.id,
            handle: item.account.handle,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (cycleErrors.length > 0) {
      throw cycleErrors[0];
    }

    const completedAtUnix = this.clock.nowUnix();
    this.syncStateRepo.set(
      LAST_TWEET_POLL_UNIX_KEY,
      String(cycleStartUnix),
      completedAtUnix,
    );

    const summary: TweetPollCycleSummary = {
      skipped: false,
      activeAccounts: activeAccounts.length,
      batchesQueried,
      tweetsFetched: allFetched.length,
      unseenTweets: unseenTweets.length,
      alertsSent,
      sinceUnix,
      completedAtUnix,
    };

    this.logger.info('Completed tweet poll cycle', { ...summary });
    return summary;
  }

  private async fetchBatchPages(
    query: string,
    fetchedById: Map<string, NormalizedTweet>,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const seenInThisBatch = new Set<string>();
    const maxPages = Math.max(1, this.options.maxPagesPerBatch);

    for (let page = 0; page < maxPages; page += 1) {
      this.throwIfAborted(signal);
      if (cursor !== null) {
        seenCursors.add(cursor);
      }

      const searchPage = await this.twitterProvider.searchRecentTweets({
        query,
        cursor,
        priority: 'NORMAL',
        signal,
      });

      let newInBatchPage = 0;
      for (const tweet of searchPage.tweets) {
        if (!seenInThisBatch.has(tweet.id)) {
          seenInThisBatch.add(tweet.id);
          newInBatchPage += 1;
        }
        if (!fetchedById.has(tweet.id)) {
          fetchedById.set(tweet.id, tweet);
        }
      }

      const nextCursor = searchPage.nextCursor?.trim() ?? '';
      if (
        !searchPage.hasNextPage ||
        nextCursor.length === 0 ||
        searchPage.tweets.length === 0
      ) {
        break;
      }

      if (seenCursors.has(nextCursor)) {
        this.logger.warn(
          'Stopping pagination due to repeated cursor from Twitter provider',
          { cursor: nextCursor, page },
        );
        break;
      }

      if (page > 0 && newInBatchPage === 0) {
        this.logger.warn(
          'Stopping pagination because page returned 0 new tweets',
          { cursor: nextCursor, page },
        );
        break;
      }

      cursor = nextCursor;
    }
  }

  private applyFloodCap(items: readonly PendingTweetNotification[]): {
    readonly selected: readonly PendingTweetNotification[];
    readonly suppressed: readonly PendingTweetNotification[];
  } {
    if (items.length <= this.maxAlertsPerCycle) {
      return { selected: items, suppressed: [] };
    }

    const highIndices: number[] = [];
    const normalIndices: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]!.signal.priority === 'HIGH') {
        highIndices.push(i);
      } else {
        normalIndices.push(i);
      }
    }

    const chosenIndexSet = new Set<number>();
    // Keep newest HIGH-priority signals first
    const keptHigh = highIndices.slice(-this.maxAlertsPerCycle);
    for (const idx of keptHigh) {
      chosenIndexSet.add(idx);
    }

    const remainingSlots = this.maxAlertsPerCycle - chosenIndexSet.size;
    if (remainingSlots > 0) {
      const keptNormal = normalIndices.slice(-remainingSlots);
      for (const idx of keptNormal) {
        chosenIndexSet.add(idx);
      }
    }

    const selected: PendingTweetNotification[] = [];
    const suppressed: PendingTweetNotification[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (chosenIndexSet.has(i)) {
        selected.push(items[i]!);
      } else {
        suppressed.push(items[i]!);
      }
    }

    return { selected, suppressed };
  }

  private computeSinceUnix(nowUnix: number): number {
    const rawLastPoll = this.syncStateRepo.get(LAST_TWEET_POLL_UNIX_KEY);
    const parsedLastPoll =
      rawLastPoll !== null ? Number.parseInt(rawLastPoll, 10) : Number.NaN;
    const hardFloorUnix = Math.max(0, nowUnix - this.options.maxLookbackSec);

    if (Number.isFinite(parsedLastPoll) && parsedLastPoll > 0) {
      return Math.max(parsedLastPoll - this.options.overlapBufferSec, hardFloorUnix);
    }

    return Math.max(nowUnix - this.options.coldStartLookbackSec, hardFloorUnix);
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('Tweet monitor cycle aborted');
      err.name = 'AbortError';
      throw err;
    }
  }
}
