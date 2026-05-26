import postgres from 'postgres';
import type { ClientKeyType, CreateRuleInput, Rule, Strategy } from './types.js';

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

// Exported for use by the query functions below. Not part of the public
// surface of this module (no caller outside lib/db.ts should need them).
export { toRule };
export type { DbRule };

// -----------------------------------------------------------------------------
// Query functions
// -----------------------------------------------------------------------------

/**
 * Returns every row in the `rules` table, newest first.
 * Used by the admin endpoint GET /api/rules.
 */
export async function listRules(): Promise<Rule[]> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`
    SELECT id, route_pattern, client_key_type, limit_count,
           window_seconds, strategy, enabled, created_at
    FROM rules
    ORDER BY created_at DESC
  `;
  return rows.map(toRule);
}

/**
 * Returns only rules where enabled = true, newest first.
 * Used by /api/check on every request -- hits the idx_rules_enabled index.
 */
export async function listEnabledRules(): Promise<Rule[]> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`
    SELECT id, route_pattern, client_key_type, limit_count,
           window_seconds, strategy, enabled, created_at
    FROM rules
    WHERE enabled = true
    ORDER BY created_at DESC
  `;
  return rows.map(toRule);
}

/**
 * Look up a single rule by id. Returns null if no row matches.
 *
 * Returns null (not throws) for "not found" so callers can map it to a 404
 * without try/catch. Real failures (connection lost, etc.) still throw.
 *
 * The ${id} interpolation is parameterised by Postgres -- never spliced into
 * the query string -- so it's safe to pass user input directly.
 */
export async function getRule(id: string): Promise<Rule | null> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`
    SELECT id, route_pattern, client_key_type, limit_count,
           window_seconds, strategy, enabled, created_at
    FROM rules
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toRule(rows[0]!);
}

/**
 * Insert a new rule and return it with its DB-generated id and created_at.
 *
 * Uses Postgres's RETURNING clause to get the new row back in the SAME
 * roundtrip as the insert -- no separate SELECT, no race conditions.
 *
 * Optional fields fall back to JS-side defaults that match the column
 * DEFAULTs in the schema (passing `${undefined}` would send NULL and
 * violate the NOT NULL constraint).
 */
export async function createRule(input: CreateRuleInput): Promise<Rule> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`
    INSERT INTO rules (
      route_pattern, client_key_type, limit_count,
      window_seconds, strategy, enabled
    )
    VALUES (
      ${input.routePattern},
      ${input.clientKeyType},
      ${input.limitCount},
      ${input.windowSeconds},
      ${input.strategy ?? 'sliding_window'},
      ${input.enabled ?? true}
    )
    RETURNING id, route_pattern, client_key_type, limit_count,
              window_seconds, strategy, enabled, created_at
  `;
  return toRule(rows[0]!);
}

/**
 * Delete a rule by id. Returns true if a row was actually removed,
 * false if no row matched (lets the API layer choose between 200 and 404).
 */
export async function deleteRule(id: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    DELETE FROM rules
    WHERE id = ${id}
  `;
  return result.count > 0;
}
