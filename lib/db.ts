import postgres from 'postgres';
import type { ClientKeyType, CreateRuleInput, Rule, Strategy } from './types.js';

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (_sql) return _sql;
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Missing POSTGRES_URL. Set it in your .env file or Vercel project settings (use the Supabase pooler URL on port 6543).'
    );
  }
  // Supabase's pooler runs in transaction mode and does not support prepared statements.
  _sql = postgres(url, { prepare: false });
  return _sql;
}

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

export async function listRules(): Promise<Rule[]> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`SELECT * FROM rules ORDER BY created_at DESC`;
  return rows.map(toRule);
}

export async function listEnabledRules(): Promise<Rule[]> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`SELECT * FROM rules WHERE enabled = true ORDER BY created_at DESC`;
  return rows.map(toRule);
}

export async function getRule(id: string): Promise<Rule | null> {
  const sql = getSql();
  const rows = await sql<DbRule[]>`SELECT * FROM rules WHERE id = ${id} LIMIT 1`;
  const first = rows[0];
  return first ? toRule(first) : null;
}

export async function createRule(input: CreateRuleInput): Promise<Rule> {
  const sql = getSql();
  const strategy: Strategy = input.strategy ?? 'sliding_window';
  const enabled = input.enabled ?? true;
  const rows = await sql<DbRule[]>`
    INSERT INTO rules (route_pattern, client_key_type, limit_count, window_seconds, strategy, enabled)
    VALUES (${input.routePattern}, ${input.clientKeyType}, ${input.limitCount}, ${input.windowSeconds}, ${strategy}, ${enabled})
    RETURNING *
  `;
  const first = rows[0];
  if (!first) throw new Error('Insert returned no row');
  return toRule(first);
}

export async function deleteRule(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`DELETE FROM rules WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
