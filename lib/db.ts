import postgres from 'postgres';
import type { ClientKeyType, Rule, Strategy } from './types.js';

// Module-level cache for the client. Same lazy/singleton pattern as getRedis().
let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Returns a shared Postgres client connected to Supabase via the pooler.
 *
 * Lazy init so importing this file is safe (no env vars needed at import time,
 * no connection opened until something actually queries).
 */
export function getSql() {
  if (_sql) return _sql;

  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Missing POSTGRES_URL. Set it in your .env file or Vercel project settings (use the Supabase pooler URL on port 6543).'
    );
  }

  // Supabase's pooler runs in transaction mode and does NOT support prepared
  // statements -- without this we get 'prepared statement "..." does not exist'
  // on any reused query. Set once here, forgotten everywhere else.
  _sql = postgres(url, { prepare: false });
  return _sql;
}

/**
 * The shape of a row in the `rules` table -- snake_case to match Postgres.
 * Kept private to this file so snake_case never leaks into the rest of the app.
 */
interface DbRule {
  id: string;
  route_pattern: string;
  client_key_type: string;
  limit_count: number;
  window_seconds: number;
  strategy: string;
  enabled: boolean;
  created_at: Date | string;
}

/**
 * Translate a raw DB row into the camelCase `Rule` the rest of the codebase uses.
 * Done by hand (not an auto-mapper) so the column-to-field contract is visible.
 *
 * The `as ClientKeyType` / `as Strategy` casts trust the DB to only hold valid
 * values. Enforced upstream by the API's validation in /api/rules.
 */
function toRule(r: DbRule): Rule {
  return {
    id: r.id,
    routePattern: r.route_pattern,
    clientKeyType: r.client_key_type as ClientKeyType,
    limitCount: r.limit_count,
    windowSeconds: r.window_seconds,
    strategy: r.strategy as Strategy,
    enabled: r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// Exported for use by the query functions added in step 15+. Not part of the
// public surface of this module (no caller outside lib/db.ts should need them).
export { toRule };
export type { DbRule };
