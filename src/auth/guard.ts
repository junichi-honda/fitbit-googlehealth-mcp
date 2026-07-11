import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export type GuardInput = {
  secretFromPath: string | undefined;
  expectedSecret: string | undefined;
  clientIp: string | undefined;
  allowedCidrs: string | undefined;
};

export type BearerGuardInput = {
  authorizationHeader: string | undefined;
  expectedSecret: string | undefined;
  clientIp: string | undefined;
  allowedCidrs: string | undefined;
};

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: GuardDenyReason };

export type GuardDenyReason =
  | 'missing_secret'
  | 'secret_mismatch'
  | 'missing_authorization'
  | 'token_mismatch'
  | 'missing_client_ip'
  | 'no_cidr_configured'
  | 'ip_not_allowed';

export function verifyAccess(input: GuardInput): GuardResult {
  if (!input.expectedSecret || !input.secretFromPath) {
    return { ok: false, status: 401, reason: 'missing_secret' };
  }
  if (!timingSafeEqual(input.secretFromPath, input.expectedSecret)) {
    return { ok: false, status: 401, reason: 'secret_mismatch' };
  }

  return verifyClientIp(input.clientIp, input.allowedCidrs);
}

export function verifyBearerAccess(input: BearerGuardInput): GuardResult {
  if (!input.expectedSecret) {
    return { ok: false, status: 401, reason: 'missing_secret' };
  }
  if (!input.authorizationHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, reason: 'missing_authorization' };
  }
  const token = input.authorizationHeader.slice('Bearer '.length).trim();
  if (!timingSafeEqual(token, input.expectedSecret)) {
    return { ok: false, status: 401, reason: 'token_mismatch' };
  }

  return verifyClientIp(input.clientIp, input.allowedCidrs);
}

function verifyClientIp(
  clientIp: string | undefined,
  allowedCidrs: string | undefined,
): GuardResult {
  if (!clientIp) {
    return { ok: false, status: 403, reason: 'missing_client_ip' };
  }

  const cidrs = parseCidrList(allowedCidrs);
  if (cidrs.length === 0) {
    return { ok: false, status: 403, reason: 'no_cidr_configured' };
  }
  if (!cidrs.some((cidr) => isIpv4InCidr(clientIp, cidr))) {
    return { ok: false, status: 403, reason: 'ip_not_allowed' };
  }

  return { ok: true };
}

export function parseCidrList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  return result >>> 0;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return false;
  const range = cidr.slice(0, slashIdx);
  const bitsStr = cidr.slice(slashIdx + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// Denial reasons worth alerting on: with IP allow-listing effectively open
// (ALLOWED_CIDRS = 0.0.0.0/0), a wrong/absent credential is the signature of
// an unauthorized probe rather than a misrouted client. `missing_secret` also
// fires if MCP_SHARED_SECRET is unset server-side, which is itself worth
// surfacing. Emitted as structured console.warn so Workers Logs / Logpush
// can trigger notifications.
const ALERT_REASONS: ReadonlySet<GuardDenyReason> = new Set([
  'missing_secret',
  'secret_mismatch',
  'missing_authorization',
  'token_mismatch',
]);

type GuardDeny = Extract<GuardResult, { ok: false }>;

const logDenied = (c: Context<{ Bindings: Env }>, result: GuardDeny, route: string): void => {
  if (!ALERT_REASONS.has(result.reason)) return;
  console.warn(
    JSON.stringify({
      event: 'guard_denied',
      severity: 'alert',
      reason: result.reason,
      status: result.status,
      clientIp: c.req.header('CF-Connecting-IP') ?? null,
      country: c.req.header('CF-IPCountry') ?? null,
      userAgent: c.req.header('User-Agent') ?? null,
      // Never log the real path: on the legacy route it embeds the shared
      // secret. (The Authorization header value is likewise never logged.)
      route,
      at: new Date().toISOString(),
    }),
  );
};

export const guardMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const result = verifyAccess({
      secretFromPath: c.req.param('secret'),
      expectedSecret: c.env.MCP_SHARED_SECRET,
      clientIp: c.req.header('CF-Connecting-IP') ?? undefined,
      allowedCidrs: c.env.ALLOWED_CIDRS,
    });
    if (!result.ok) {
      logDenied(c, result, 'POST /mcp/:secret');
      return c.text(result.reason, result.status);
    }
    await next();
  };
};

export const bearerGuardMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const result = verifyBearerAccess({
      authorizationHeader: c.req.header('Authorization'),
      expectedSecret: c.env.MCP_SHARED_SECRET,
      clientIp: c.req.header('CF-Connecting-IP') ?? undefined,
      allowedCidrs: c.env.ALLOWED_CIDRS,
    });
    if (!result.ok) {
      logDenied(c, result, 'POST /mcp');
      if (result.status === 401) {
        c.header('WWW-Authenticate', 'Bearer');
      }
      return c.text(result.reason, result.status);
    }
    await next();
  };
};
