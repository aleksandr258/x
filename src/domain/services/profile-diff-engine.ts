import type { TrackedAccount, TwitterUserProfile } from '../entities/account.js';
import type {
  ProfileDiffResult,
  ProfileFieldChange,
} from '../entities/profile-diff.js';
import type { AlertPriority } from '../entities/signal.js';
import { NftSignalAnalyzer } from './nft-signal-analyzer.js';

export class ProfileDiffEngine {
  /**
   * Computes a structured "было → стало" diff between a stored TrackedAccount snapshot
   * and a freshly fetched TwitterUserProfile, including NFT signal scoring on updated fields.
   */
  public static diff(
    previous: TrackedAccount,
    current: TwitterUserProfile,
    keywords: readonly string[],
  ): ProfileDiffResult {
    const changes: ProfileFieldChange[] = [];

    // Handle unavailable state transitions cleanly without wiping stored bio/name/media
    if (current.availability === 'unavailable') {
      if (
        current.handle.trim().length > 0 &&
        previous.handle.toLowerCase() !== current.handle.trim().toLowerCase()
      ) {
        changes.push({
          field: 'handle',
          before: `@${previous.handle}`,
          after: `@${current.handle.trim().toLowerCase()}`,
        });
      }

      const prevAvailLabel = this.formatAvailability(
        previous.availability,
        previous.unavailableReason,
      );
      const currAvailLabel = this.formatAvailability(
        current.availability,
        current.unavailableReason,
      );

      if (previous.availability !== 'unavailable' || prevAvailLabel !== currAvailLabel) {
        changes.push({
          field: 'availability',
          before: prevAvailLabel,
          after: currAvailLabel,
        });
      }

      const emptySignal = NftSignalAnalyzer.analyzeTextAndUrls([], [], keywords);
      return {
        hasChanges: changes.length > 0,
        changes,
        signal: emptySignal,
        priority: changes.length > 0 ? 'HIGH' : 'NORMAL',
      };
    }

    // Account is available: check recovery from unavailable
    if (previous.availability !== 'available') {
      changes.push({
        field: 'availability',
        before: this.formatAvailability(
          previous.availability,
          previous.unavailableReason,
        ),
        after: 'available',
      });
    }

    // 1. Handle rename / rebrand check (case-insensitive canonical comparison)
    const prevHandle = previous.handle.trim().toLowerCase();
    const currHandle = current.handle.trim().toLowerCase();
    if (currHandle.length > 0 && prevHandle !== currHandle) {
      changes.push({
        field: 'handle',
        before: `@${prevHandle}`,
        after: `@${currHandle}`,
      });
    }

    // 2. Display Name
    const prevName = previous.displayName.trim();
    const currName = current.displayName.trim();
    if (prevName !== currName) {
      changes.push({
        field: 'displayName',
        before: prevName.length > 0 ? prevName : null,
        after: currName.length > 0 ? currName : null,
      });
    }

    // 3. Bio / Description
    const prevBio = this.normalizeText(previous.bio);
    const currBio = this.normalizeText(current.bio);
    if (prevBio !== currBio) {
      changes.push({
        field: 'bio',
        before: prevBio.length > 0 ? prevBio : null,
        after: currBio.length > 0 ? currBio : null,
      });
    }

    // 4. Website URL
    const prevWeb = this.normalizeWebsiteUrl(previous.websiteUrl);
    const currWeb = this.normalizeWebsiteUrl(current.websiteUrl);
    if (prevWeb !== currWeb) {
      changes.push({
        field: 'websiteUrl',
        before: previous.websiteUrl?.trim() || null,
        after: current.websiteUrl?.trim() || null,
      });
    }

    // 5. Avatar URL (canonicalized so _normal -> _400x400 size suffixes don't trigger false alerts)
    const prevAvatar = this.normalizeAvatarUrl(previous.avatarUrl);
    const currAvatar = this.normalizeAvatarUrl(current.avatarUrl);
    if (prevAvatar !== currAvatar) {
      changes.push({
        field: 'avatarUrl',
        before: prevAvatar,
        after: currAvatar,
      });
    }

    // 6. Banner URL
    const prevBanner = this.normalizeBannerUrl(previous.bannerUrl);
    const currBanner = this.normalizeBannerUrl(current.bannerUrl);
    if (prevBanner !== currBanner) {
      changes.push({
        field: 'bannerUrl',
        before: prevBanner,
        after: currBanner,
      });
    }

    if (changes.length === 0) {
      const emptySignal = NftSignalAnalyzer.analyzeTextAndUrls([], [], keywords);
      return {
        hasChanges: false,
        changes: [],
        signal: emptySignal,
        priority: 'NORMAL',
      };
    }

    // Run NFT signal analysis on newly updated profile text & website fields
    const signalTexts: string[] = [];
    const signalUrls: string[] = [];

    if (changes.some((c) => c.field === 'displayName') && currName.length > 0) {
      signalTexts.push(currName);
    }
    if (changes.some((c) => c.field === 'bio') && currBio.length > 0) {
      signalTexts.push(currBio);
    }
    if (
      changes.some((c) => c.field === 'websiteUrl') &&
      current.websiteUrl !== null &&
      current.websiteUrl.trim().length > 0
    ) {
      signalUrls.push(current.websiteUrl.trim());
    }

    const signal = NftSignalAnalyzer.analyzeTextAndUrls(
      signalTexts,
      signalUrls,
      keywords,
    );

    const handleChanged = changes.some((c) => c.field === 'handle');
    const availabilityChanged = changes.some((c) => c.field === 'availability');
    const websiteAddedOrUpdated = changes.some(
      (c) => c.field === 'websiteUrl' && c.after !== null,
    );

    const priority: AlertPriority =
      handleChanged ||
      availabilityChanged ||
      websiteAddedOrUpdated ||
      signal.priority === 'HIGH' ||
      signal.links.length > 0
        ? 'HIGH'
        : 'NORMAL';

    return {
      hasChanges: true,
      changes,
      signal,
      priority,
    };
  }

  public static normalizeAvatarUrl(url: string | null | undefined): string | null {
    if (!url || url.trim().length === 0) {
      return null;
    }
    const trimmed = url.trim();
    const withoutQuery = trimmed.split('?')[0]?.split('#')[0] ?? trimmed;
    return withoutQuery.replace(
      /_(normal|bigger|mini|200x200|x96)(\.[a-zA-Z0-9]+)$/i,
      '_400x400$2',
    );
  }

  public static normalizeBannerUrl(url: string | null | undefined): string | null {
    if (!url || url.trim().length === 0) {
      return null;
    }
    const trimmed = url.trim();
    const withoutQuery = trimmed.split('?')[0]?.split('#')[0] ?? trimmed;
    return withoutQuery.replace(/\/(1500x500|600x200|web|ipad|mobile)$/i, '');
  }

  private static normalizeText(value: string): string {
    return value.replace(/\r\n/g, '\n').trim();
  }

  private static normalizeWebsiteUrl(url: string | null): string | null {
    if (url === null) {
      return null;
    }
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      const parsed = new URL(trimmed);
      const pathname =
        parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
          ? parsed.pathname.slice(0, -1)
          : parsed.pathname === '/'
            ? ''
            : parsed.pathname;
      return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
    } catch {
      return trimmed;
    }
  }

  private static formatAvailability(
    availability: 'available' | 'unavailable',
    reason: string | null,
  ): string {
    if (availability === 'available') {
      return 'available';
    }
    return reason && reason.trim().length > 0
      ? `unavailable (${reason.trim()})`
      : 'unavailable';
  }
}
