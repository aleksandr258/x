export class TwitterProviderError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TwitterProviderError';
  }
}

export class TwitterProviderHttpError extends TwitterProviderError {
  public readonly statusCode: number;
  public readonly responseBody: string;

  public constructor(
    message: string,
    statusCode: number,
    responseBody: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TwitterProviderHttpError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class TwitterProviderRateLimitError extends TwitterProviderHttpError {
  public readonly retryAfterMs: number | null;

  public constructor(
    message: string,
    responseBody: string,
    retryAfterMs: number | null,
  ) {
    super(message, 429, responseBody);
    this.name = 'TwitterProviderRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class TwitterProviderAuthOrQuotaError extends TwitterProviderHttpError {
  public constructor(statusCode: 401 | 402 | 403, responseBody: string) {
    super(
      `TwitterAPI.io authentication or quota error (HTTP ${statusCode})`,
      statusCode,
      responseBody,
    );
    this.name = 'TwitterProviderAuthOrQuotaError';
  }
}
