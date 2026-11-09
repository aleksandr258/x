export type AlertPriority = 'HIGH' | 'NORMAL';

export type Web3LinkCategory =
  | 'discord'
  | 'marketplace'
  | 'launchpad'
  | 'raffle'
  | 'other';

export interface CategorizedLink {
  readonly url: string;
  readonly hostname: string;
  readonly category: Web3LinkCategory;
}

export interface NftSignalAnalysis {
  readonly priority: AlertPriority;
  readonly matchedKeywords: readonly string[];
  readonly evmAddresses: readonly string[];
  readonly links: readonly CategorizedLink[];
}
