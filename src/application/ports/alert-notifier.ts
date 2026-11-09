import type {
  ProfileAlertEvent,
  SystemAlertEvent,
  TweetAlertEvent,
} from '../../domain/entities/alerts.js';

export class AlertDeliveryError extends Error {
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options: { readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AlertDeliveryError';
    this.retryable = options.retryable;
  }
}

export function isNonRetryableDeliveryError(err: unknown): boolean {
  return err instanceof AlertDeliveryError && !err.retryable;
}

export interface AlertNotifier {
  sendTweetAlert(event: TweetAlertEvent): Promise<void>;
  sendProfileAlert(event: ProfileAlertEvent): Promise<void>;
  sendSystemAlert(event: SystemAlertEvent): Promise<void>;
}
