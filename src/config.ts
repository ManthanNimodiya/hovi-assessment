// All settings come from environment variables, with safe local defaults.
const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  // Public URL of this service. Wallets on phones must be able to reach it (HTTPS in production).
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  // Protects the licence authority's admin actions (issue, revoke). Test value only.
  adminKey: process.env.ADMIN_KEY ?? 'demo-admin-key',
  // Askar storage. Defaults to SQLite files in ./data. Set DATABASE_URL (postgres://user:pass@host:port/db) for Postgres.
  databaseUrl: process.env.DATABASE_URL,
  storeKey: process.env.STORE_KEY ?? 'driveproof-test-store-key',
  dataDir: process.env.DATA_DIR ?? './data',
};

export const host = new URL(config.baseUrl).host;
export const hostname = new URL(config.baseUrl).hostname;
