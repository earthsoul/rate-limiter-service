import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createRule, listRules } from '../../lib/db.js';
import type { CreateRuleInput } from '../../lib/types.js';

/**
 * Runtime validator for the POST body. Follows "parse, don't validate":
 * returns the typed value on success, an error message on failure. Callers
 * narrow on `parsed.ok` and use `parsed.value` directly with no further casts.
 *
 * TypeScript types are erased at runtime, so `req.body as CreateRuleInput`
 * is a promise to the compiler -- not a check against the actual value.
 * Every field that crosses the network boundary gets validated here.
 */
function parseCreateRuleInput(body: unknown):
  | { ok: true; value: CreateRuleInput }
  | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.routePattern !== 'string' || b.routePattern.length === 0) {
    return { ok: false, error: 'routePattern must be a non-empty string' };
  }
  if (b.clientKeyType !== 'ip' && b.clientKeyType !== 'api_key' && b.clientKeyType !== 'user_id') {
    return { ok: false, error: "clientKeyType must be one of 'ip', 'api_key', 'user_id'" };
  }
  if (typeof b.limitCount !== 'number' || !Number.isInteger(b.limitCount) || b.limitCount <= 0) {
    return { ok: false, error: 'limitCount must be a positive integer' };
  }
  if (typeof b.windowSeconds !== 'number' || !Number.isInteger(b.windowSeconds) || b.windowSeconds <= 0) {
    return { ok: false, error: 'windowSeconds must be a positive integer' };
  }
  if (b.strategy !== undefined && b.strategy !== 'sliding_window' && b.strategy !== 'fixed_window') {
    return { ok: false, error: "strategy must be 'sliding_window' or 'fixed_window'" };
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }

  return {
    ok: true,
    value: {
      routePattern: b.routePattern,
      clientKeyType: b.clientKeyType,
      limitCount: b.limitCount,
      windowSeconds: b.windowSeconds,
      strategy: b.strategy,
      enabled: b.enabled,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    try {
      const rules = await listRules();
      // Wrapped in an object so we can add pagination fields later without
      // breaking clients that depend on the response shape.
      return res.status(200).json({ rules });
    } catch (err) {
      console.error('GET /api/rules failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'POST') {
    const parsed = parseCreateRuleInput(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'invalid_input', message: parsed.error });
    }
    try {
      const rule = await createRule(parsed.value);
      // 201 Created -- not 200 -- because a new resource was created.
      return res.status(201).json({ rule });
    } catch (err) {
      console.error('POST /api/rules failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  // RFC 7231: a 405 response MUST include an Allow header listing the
  // methods this endpoint does accept.
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'method_not_allowed' });
}
