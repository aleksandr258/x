import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type {
  DatabaseMaintainer,
  SeenTweetRepository,
  SyncStateRepository,
} from '../ports/repositories.js';

export const LAST_MAINTENANCE_UNIX_KEY = 'last_maintenance_unix';

export interface MaintenanceSummary {
  readonly prunedTweets: number;
  readonly completedAtUnix: number;
}

export class MaintenanceService {
  public constructor(
    private readonly seenTweetRepo: SeenTweetRepository,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly dbMaintainer: DatabaseMaintainer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly retentionDays: number,
  ) {}

  public runCleanup(): MaintenanceSummary {
    const nowUnix = this.clock.nowUnix();
    const retentionSeconds = Math.max(1, this.retentionDays) * 86_400;
    const cutoffUnix = nowUnix - retentionSeconds;

    const prunedTweets = this.seenTweetRepo.pruneOlderThan(cutoffUnix);
    this.dbMaintainer.optimize();
    this.syncStateRepo.set(LAST_MAINTENANCE_UNIX_KEY, String(nowUnix), nowUnix);

    this.logger.info('Completed database maintenance', {
      prunedTweets,
      retentionDays: this.retentionDays,
      cutoffUnix,
    });

    return {
      prunedTweets,
      completedAtUnix: nowUnix,
    };
  }
}
