export type Env = {
  TOKENS: KVNamespace;
  CACHE: KVNamespace;
  /**
   * Backing provider for all MCP tools. Defaults to 'fitbit' when unset so
   * existing deployments keep working; flip to 'google' (wrangler.toml
   * [vars]) after Google OAuth tokens have been loaded into TOKENS.
   */
  HEALTH_PROVIDER?: 'fitbit' | 'google';
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MCP_SHARED_SECRET: string;
  ALLOWED_CIDRS: string;
};
