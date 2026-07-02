export class FitbitAuthError extends Error {
  readonly code = 'fitbit_auth_error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'FitbitAuthError';
  }
}

export class FitbitApiError extends Error {
  readonly code = 'fitbit_api_error' as const;
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly endpoint?: string,
  ) {
    super(`Fitbit API ${status} at ${endpoint ?? '<unknown>'}: ${bodyText.slice(0, 240)}`);
    this.name = 'FitbitApiError';
  }
}

export class FitbitRateLimitError extends Error {
  readonly code = 'fitbit_rate_limit_error' as const;
  constructor(
    public readonly retryAfterSec: number,
    public readonly endpoint?: string,
  ) {
    super(
      `Fitbit rate limit exceeded at ${endpoint ?? '<unknown>'} (Retry-After: ${retryAfterSec}s)`,
    );
    this.name = 'FitbitRateLimitError';
  }
}

export class GoogleHealthAuthError extends Error {
  readonly code = 'google_health_auth_error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GoogleHealthAuthError';
  }
}

export class GoogleHealthApiError extends Error {
  readonly code = 'google_health_api_error' as const;
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly endpoint?: string,
  ) {
    super(`Google Health API ${status} at ${endpoint ?? '<unknown>'}: ${bodyText.slice(0, 240)}`);
    this.name = 'GoogleHealthApiError';
  }
}

export class GoogleHealthRateLimitError extends Error {
  readonly code = 'google_health_rate_limit_error' as const;
  constructor(
    public readonly retryAfterSec: number,
    public readonly endpoint?: string,
  ) {
    super(
      `Google Health API rate limit exceeded at ${endpoint ?? '<unknown>'} (Retry-After: ${retryAfterSec}s)`,
    );
    this.name = 'GoogleHealthRateLimitError';
  }
}

export type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function toolErrorResult(err: unknown): ToolTextResult {
  const message = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (err instanceof FitbitAuthError) {
    hint =
      '\n\nHint: tokens may be missing or the refresh token is revoked. ' +
      'Re-run `pnpm run setup:fitbit` from a developer machine and repopulate the TOKENS KV namespace.';
  } else if (err instanceof GoogleHealthAuthError) {
    hint =
      '\n\nHint: Google tokens may be missing, expired, or revoked. Refresh tokens issued while ' +
      'the OAuth consent screen is in "Testing" expire after 7 days — publish it to "In production", ' +
      'then re-run `pnpm run setup:google` from a developer machine and repopulate the TOKENS KV namespace.';
  } else if (err instanceof FitbitRateLimitError) {
    hint = `\n\nHint: retry after ${err.retryAfterSec}s. Fitbit enforces 150 requests/hour/user.`;
  } else if (err instanceof GoogleHealthRateLimitError) {
    hint = `\n\nHint: retry after ${err.retryAfterSec}s.`;
  }
  return {
    content: [{ type: 'text', text: `Error: ${message}${hint}` }],
    isError: true,
  };
}
