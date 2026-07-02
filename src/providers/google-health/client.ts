import type { ZodType } from 'zod';
import type { Env } from '../../env';
import { GoogleHealthApiError, GoogleHealthRateLimitError } from '../../lib/errors';
import { parseRetryAfter, sleep } from '../../lib/rate-limit';
import { getAccessToken, invalidateAccessToken } from './oauth';

const GOOGLE_HEALTH_API_BASE = 'https://health.googleapis.com';

export type GoogleHealthRequest = {
  /** Absolute path starting with `/`, e.g. `/v4/users/me/profile`. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | undefined>;
  /** JSON request body — the Google Health API speaks JSON (Fitbit used form encoding). */
  json?: unknown;
};

export class GoogleHealthClient {
  constructor(private readonly env: Env) {}

  async requestJson<T>(schema: ZodType<T>, req: GoogleHealthRequest): Promise<T> {
    const body = await this.requestText(req);
    // Empty-body 200s happen on custom methods like `:batchDelete`.
    const parsed = schema.safeParse(body === '' ? {} : JSON.parse(body));
    if (!parsed.success) {
      // Include a slice of the raw body so future schema mismatches are
      // diagnosable from the MCP tool error alone (wrangler tail doesn't
      // surface console logs from inside the Worker in pretty mode).
      const rawPreview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      throw new GoogleHealthApiError(
        200,
        `Schema validation failed at ${req.path}: ${parsed.error.message}\nRaw body preview: ${rawPreview}`,
        req.path,
      );
    }
    return parsed.data;
  }

  async requestText(req: GoogleHealthRequest): Promise<string> {
    const url = new URL(req.path, GOOGLE_HEALTH_API_BASE);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 3; // original + one refresh retry + one rate-limit retry
    while (true) {
      attempt++;
      const token = await getAccessToken(this.env);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      let body: BodyInit | undefined;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['Content-Type'] = 'application/json';
      }

      const t0 = Date.now();
      const res = await fetch(url, { method: req.method ?? 'GET', headers, body });
      const ms = Date.now() - t0;
      const method = req.method ?? 'GET';

      if (res.status === 401 && attempt === 1) {
        // token was rejected — force refresh and try once
        console.log(`[google-health] ${method} ${req.path} → 401 after ${ms}ms, refreshing token`);
        await invalidateAccessToken(this.env);
        continue;
      }

      if (res.status === 429) {
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'));
        if (attempt < MAX_ATTEMPTS) {
          console.log(
            `[google-health] ${method} ${req.path} → 429, sleeping ${waitSec}s before retry`,
          );
          await sleep(waitSec * 1000);
          continue;
        }
        throw new GoogleHealthRateLimitError(waitSec, req.path);
      }

      const text = await res.text();
      if (!res.ok) {
        console.log(
          `[google-health] ${method} ${req.path} → ${res.status} after ${ms}ms: ${text.slice(0, 300)}`,
        );
        throw new GoogleHealthApiError(res.status, text, req.path);
      }
      return text;
    }
  }
}
