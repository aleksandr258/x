import type { AlertPriority, NftSignalAnalysis } from './signal.js';

export type ProfileChangedField =
  | 'handle'
  | 'displayName'
  | 'bio'
  | 'websiteUrl'
  | 'avatarUrl'
  | 'bannerUrl'
  | 'availability';

export interface ProfileFieldChange {
  readonly field: ProfileChangedField;
  readonly before: string | null;
  readonly after: string | null;
}

export interface ProfileDiffResult {
  readonly hasChanges: boolean;
  readonly changes: readonly ProfileFieldChange[];
  readonly signal: NftSignalAnalysis;
  readonly priority: AlertPriority;
}
