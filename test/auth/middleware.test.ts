import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerGuardMiddleware, guardMiddleware } from '../../src/auth/guard';
import type { Env } from '../../src/env';
import { createMockEnv } from '../helpers/mock-env';

const SECRET = 'test-shared-secret';
const ALLOWED_IP = '160.79.105.42';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/mcp', bearerGuardMiddleware(), (c) => c.text('ok'));
  app.post('/mcp/:secret', guardMiddleware(), (c) => c.text('ok'));
  return app;
}

describe('bearerGuardMiddleware', () => {
  it('passes through with a valid Bearer token and allowed IP', async () => {
    const res = await buildApp().request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'CF-Connecting-IP': ALLOWED_IP,
        },
      },
      createMockEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns 401 with WWW-Authenticate when the Authorization header is missing', async () => {
    const res = await buildApp().request(
      '/mcp',
      { method: 'POST', headers: { 'CF-Connecting-IP': ALLOWED_IP } },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.text()).toBe('missing_authorization');
  });

  it('returns 401 with WWW-Authenticate on a wrong token', async () => {
    const res = await buildApp().request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-token',
          'CF-Connecting-IP': ALLOWED_IP,
        },
      },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.text()).toBe('token_mismatch');
  });

  it('returns 403 without WWW-Authenticate when the IP is not allowed', async () => {
    const res = await buildApp().request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'CF-Connecting-IP': '1.2.3.4',
        },
      },
      createMockEnv(),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(await res.text()).toBe('ip_not_allowed');
  });
});

describe('guardMiddleware (legacy path-secret route)', () => {
  it('still passes through with the secret in the path', async () => {
    const res = await buildApp().request(
      `/mcp/${SECRET}`,
      { method: 'POST', headers: { 'CF-Connecting-IP': ALLOWED_IP } },
      createMockEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('still rejects a wrong path secret', async () => {
    const res = await buildApp().request(
      '/mcp/wrong-secret',
      { method: 'POST', headers: { 'CF-Connecting-IP': ALLOWED_IP } },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('secret_mismatch');
  });
});
