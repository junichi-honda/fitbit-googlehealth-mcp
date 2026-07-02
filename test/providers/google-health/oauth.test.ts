import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthAuthError } from '../../../src/lib/errors';
import {
  getAccessToken,
  invalidateAccessToken,
  refreshTokens,
} from '../../../src/providers/google-health/oauth';
import { createMockEnv } from '../../helpers/mock-env';

describe('getAccessToken (google)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns current access_token when not near expiry', async () => {
    const env = createMockEnv({
      access_token: 'current-token',
      refresh_token: 'refresh-xyz',
      expires_at: String(Math.floor(Date.now() / 1000) + 600),
      user_id: 'me',
    });
    const token = await getAccessToken(env);
    expect(token).toBe('current-token');
  });

  it('refreshes when access_token is within the 60-second skew window', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-token',
            expires_in: 3599,
            scope: 'https://www.googleapis.com/auth/googlehealth.profile.readonly',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({
      access_token: 'stale',
      refresh_token: 'refresh-xyz',
      // 30s from now → inside the 60s skew, must refresh
      expires_at: String(Math.floor(Date.now() / 1000) + 30),
      user_id: 'me',
    });

    const token = await getAccessToken(env);
    expect(token).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.TOKENS.get('access_token')).toBe('new-token');
  });

  it('throws GoogleHealthAuthError when tokens are missing', async () => {
    const env = createMockEnv();
    await expect(getAccessToken(env)).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });

  it('throws GoogleHealthAuthError when expires_at is not numeric', async () => {
    const env = createMockEnv({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 'garbage',
    });
    await expect(getAccessToken(env)).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });
});

describe('refreshTokens (google)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists the new bundle with expires_at = now + expires_in', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'a2',
            refresh_token: 'r2',
            expires_in: 3599,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    const result = await refreshTokens(env, 'old-refresh');

    expect(result.accessToken).toBe('a2');
    expect(result.refreshToken).toBe('r2');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(result.expiresAt).toBe(nowSec + 3599);
    expect(await env.TOKENS.get('expires_at')).toBe(String(nowSec + 3599));
  });

  it('keeps the previous refresh_token when Google omits it from the response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'a2',
            expires_in: 3599,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    const result = await refreshTokens(env, 'old-refresh');

    expect(result.refreshToken).toBe('old-refresh');
    expect(await env.TOKENS.get('refresh_token')).toBe('old-refresh');
  });

  it('sends client credentials in the form body (no Basic auth) to the Google token endpoint', async () => {
    // `_url` / `_init` are intentionally present so fetchMock.mock.calls is
    // typed as [url, init] rather than [].
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'a2',
            expires_in: 100,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    await refreshTokens(env, 'rt');

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('test-google-client-id');
    expect(body.get('client_secret')).toBe('test-google-client-secret');
  });

  it('throws GoogleHealthAuthError with the response body on HTTP 4xx/5xx', async () => {
    const fetchMock = vi.fn(
      async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    await expect(refreshTokens(env, 'rt')).rejects.toThrow(/invalid_grant/);
  });

  it('throws GoogleHealthAuthError when client id / secret are absent', async () => {
    const env = createMockEnv({}, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    await expect(refreshTokens(env, 'rt')).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });
});

describe('invalidateAccessToken (google)', () => {
  it('writes expires_at=0 so the next getAccessToken is forced to refresh', async () => {
    const env = createMockEnv({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: '9999999999',
    });
    await invalidateAccessToken(env);
    expect(await env.TOKENS.get('expires_at')).toBe('0');
  });
});
