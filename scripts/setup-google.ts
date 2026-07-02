#!/usr/bin/env tsx
/**
 * One-shot Google Health OAuth bootstrap CLI.
 *
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   pnpm run setup:google
 *
 * Starts a tiny localhost callback server, walks the user through the
 * Authorization Code + PKCE flow in their system browser, exchanges the
 * code for tokens, and prints the exact `wrangler` commands needed to
 * move those tokens into Workers KV / Secrets.
 *
 * ★ Run this only after the OAuth consent screen's publishing status is
 * "In production" (https://console.developers.google.com/auth/audience).
 * Refresh tokens minted while the app is in "Testing" expire after 7
 * days, which breaks the unattended refresh loop inside the Worker.
 *
 * The MCP Worker itself never runs this code path — Claude mobile /
 * claude.ai never sees the Google OAuth screen. This avoids Google's
 * `disallowed_useragent` policy that blocks embedded WebViews.
 */

import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8787;
const CALLBACK_PATH = '/google/callback';

// Google Health scopes are split read/write (2026-05-26 change); each one
// must also be enabled on the project's Data Access page
// (https://console.developers.google.com/auth/scopes) or consent fails.
const SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth.';
const SCOPES = [
  'activity_and_fitness.readonly',
  'activity_and_fitness.writeonly',
  'health_metrics_and_measurements.readonly',
  'health_metrics_and_measurements.writeonly',
  'sleep.readonly',
  'sleep.writeonly',
  'nutrition.readonly',
  'nutrition.writeonly',
  'profile.readonly',
  'settings.readonly',
].map((scope) => SCOPE_BASE + scope);

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin'
      ? `open '${url}'`
      : platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(cmd, (err) => {
    if (err) {
      // best effort; user can copy the URL from stdout
    }
  });
}

function waitForCallback(opts: { expectedState: string }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Google authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Google OAuth error: ${error} ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 24px}</style></head>
<body>
<h1>✓ Authorized</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`);
      server.close();
      resolve({ code });
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponseT> {
  // Google's token endpoint takes credentials in the form body, not Basic auth.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const json = JSON.parse(text);
  return TokenResponse.parse(json);
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    console.error('');
    console.error('  1. Enable the Google Health API:');
    console.error('     https://console.developers.google.com/apis/library/health.googleapis.com');
    console.error('  2. Add the Google Health scopes on the Data Access page:');
    console.error('     https://console.developers.google.com/auth/scopes');
    console.error('  3. Create an OAuth client ID (type: Web application):');
    console.error('     https://console.developers.google.com/apis/credentials');
    console.error(
      `     Authorized redirect URI: http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
    );
    console.error('  4. Export the values:');
    console.error('     export GOOGLE_CLIENT_ID=...');
    console.error('     export GOOGLE_CLIENT_SECRET=...');
    console.error('  5. Run again: pnpm run setup:google');
    process.exit(1);
  }

  const state = base64url(randomBytes(16));
  const { verifier, challenge } = generatePkce();
  const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // Both are required to guarantee a refresh_token in the response.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('');
  console.log('Google Health OAuth bootstrap');
  console.log('─────────────────────────────');
  console.log('');
  console.log('★ Before continuing, confirm the OAuth consent screen is "In production"');
  console.log('  (https://console.developers.google.com/auth/audience).');
  console.log('  Refresh tokens issued under "Testing" expire after 7 days and the');
  console.log('  unattended Worker refresh loop will break weekly.');
  console.log('');
  console.log('Redirect URI (must match the OAuth client settings):');
  console.log(`  ${redirectUri}`);
  console.log('');
  console.log('Opening authorization URL in your default browser…');
  console.log('(If it does not open automatically, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
  console.log('');

  openInBrowser(authUrl.toString());

  const { code } = await waitForCallback({ expectedState: state });

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. This usually means a prior grant is still ' +
        'active — revoke the app at https://myaccount.google.com/permissions and run again ' +
        '(access_type=offline & prompt=consent are already set by this script).',
    );
  }
  const refreshToken = tokens.refresh_token;
  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

  console.log('✓ Got tokens');
  console.log('');
  console.log(`  scope:         ${tokens.scope ?? '(not echoed)'}`);
  console.log(`  token_type:    ${tokens.token_type ?? 'Bearer'}`);
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(refreshToken)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s (unix epoch: ${expiresAt})`);
  console.log('');
  console.log('Next: store these on Cloudflare Workers.');
  console.log('──────────────────────────────────────────');
  console.log('');
  console.log('1) One-time KV namespace creation (if not yet done):');
  console.log('   pnpm wrangler kv namespace create TOKENS');
  console.log('   pnpm wrangler kv namespace create CACHE');
  console.log('   # paste returned ids into wrangler.toml');
  console.log('');
  console.log('2) Secrets:');
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_ID');
  console.log(`     ↳ value: ${clientId}`);
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_SECRET');
  console.log('     ↳ value: <your Google OAuth client secret>');
  console.log('   pnpm wrangler secret put MCP_SHARED_SECRET   # keep the existing one to');
  console.log('     ↳ preserve the claude.ai connector URL');
  console.log('');
  console.log('3) Google tokens into the TOKENS KV namespace (--remote matters):');
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS refresh_token '${refreshToken}'`,
  );
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS access_token  '${tokens.access_token}'`,
  );
  console.log(`   pnpm wrangler kv key put --remote --binding=TOKENS expires_at    '${expiresAt}'`);
  console.log(`   pnpm wrangler kv key put --remote --binding=TOKENS user_id       'me'`);
  console.log('');
  console.log('4) Switch the Worker to the Google provider:');
  console.log('   # wrangler.toml [vars] → HEALTH_PROVIDER = "google"');
  console.log('');
  console.log('5) Deploy: pnpm deploy');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
