import { z } from 'zod';
import type { Env } from '../../env';
import { GoogleHealthAuthError } from '../../lib/errors';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google's refresh-grant response omits refresh_token unless it rotated,
// and never carries a user_id (the Health API addresses the user as
// `users/me`), so both diverge from the Fitbit token shape.
const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

const REFRESH_SKEW_SEC = 60;

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

async function readStoredTokens(env: Env): Promise<TokenBundle> {
  const [accessToken, refreshToken, expiresAtRaw] = await Promise.all([
    env.TOKENS.get('access_token'),
    env.TOKENS.get('refresh_token'),
    env.TOKENS.get('expires_at'),
  ]);
  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new GoogleHealthAuthError(
      'Google tokens not found in TOKENS KV. Run `pnpm run setup:google` on a developer machine and populate the namespace.',
    );
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new GoogleHealthAuthError(`expires_at in KV is not numeric: ${expiresAtRaw}`);
  }
  return { accessToken, refreshToken, expiresAt };
}

async function persistTokens(
  env: Env,
  tokens: TokenResponseT,
  previousRefreshToken: string,
  issuedAtSec: number,
): Promise<void> {
  const expiresAt = issuedAtSec + tokens.expires_in;
  await Promise.all([
    env.TOKENS.put('access_token', tokens.access_token),
    env.TOKENS.put('refresh_token', tokens.refresh_token ?? previousRefreshToken),
    env.TOKENS.put('expires_at', String(expiresAt)),
  ]);
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenBundle> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleHealthAuthError(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Run `wrangler secret put ...`.',
    );
  }

  // Google's token endpoint takes credentials in the form body, not Basic auth.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GoogleHealthAuthError(
      `Token refresh failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }

  let parsed: TokenResponseT;
  try {
    parsed = TokenResponse.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GoogleHealthAuthError(
      `Token refresh returned unexpected payload (${reason}): ${text}`,
    );
  }

  const issuedAtSec = Math.floor(Date.now() / 1000);
  await persistTokens(env, parsed, refreshToken, issuedAtSec);

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? refreshToken,
    expiresAt: issuedAtSec + parsed.expires_in,
  };
}

/**
 * Returns a currently-valid access token, refreshing it when within
 * REFRESH_SKEW_SEC of expiry. Google access tokens live ~1 hour.
 *
 * Concurrency note: Google keeps the previous access token usable until its
 * original expiry even after a refresh, and the refresh token itself is not
 * rotated on every grant, so two simultaneous refreshes both succeed — no
 * KV-CAS lock needed (same trade-off as the Fitbit provider).
 */
export async function getAccessToken(env: Env): Promise<string> {
  const current = await readStoredTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (current.expiresAt - REFRESH_SKEW_SEC > now) {
    return current.accessToken;
  }
  const refreshed = await refreshTokens(env, current.refreshToken);
  return refreshed.accessToken;
}

/** Force the next `getAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateAccessToken(env: Env): Promise<void> {
  await env.TOKENS.put('expires_at', '0');
}
