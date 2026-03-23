export interface Env {
  DB: D1Database;
  SESSION_BRIDGE: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  MAX_SESSIONS: string;
}
