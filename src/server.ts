import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { FitbitProvider } from './providers/fitbit';
import { GoogleHealthProvider } from './providers/google-health';
import type { HealthProvider } from './providers/types';
import { registerAllTools } from './tools';

function buildProvider(env: Env): HealthProvider {
  const which = env.HEALTH_PROVIDER ?? 'fitbit';
  if (which === 'google') return new GoogleHealthProvider(env);
  if (which === 'fitbit') return new FitbitProvider(env);
  throw new Error(`Unsupported HEALTH_PROVIDER "${String(which)}" (expected "google" or "fitbit")`);
}

export function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'fitbit-googlehealth-mcp',
    version: '0.1.0',
  });
  registerAllTools(server, buildProvider(env), env);
  return server;
}
