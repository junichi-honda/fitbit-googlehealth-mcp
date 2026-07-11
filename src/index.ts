import { StreamableHTTPTransport } from '@hono/mcp';
import { type Context, Hono } from 'hono';
import { bearerGuardMiddleware, guardMiddleware } from './auth/guard';
import type { Env } from './env';
import { buildServer } from './server';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('fitbit-googlehealth-mcp — see /health and POST /mcp (Bearer auth)'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-googlehealth-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

const mcpHandler = async (c: Context<{ Bindings: Env }>) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
};

app.post('/mcp', bearerGuardMiddleware(), mcpHandler);

// Legacy path-embedded-secret route, kept during the migration to Bearer
// auth. Remove once the claude.ai connector is confirmed working with the
// Authorization header.
app.post('/mcp/:secret', guardMiddleware(), mcpHandler);

export default app;
