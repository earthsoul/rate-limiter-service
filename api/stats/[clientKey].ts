import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listEnabledRules } from '../../lib/db.js';
import { findBestRule, parseClientKey } from '../../lib/matcher.js';
import { getCurrentCount } from '../../lib/redis.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { clientKey } = req.query;
  if (typeof clientKey !== 'string' || !clientKey) {
    return res.status(400).json({ error: 'Invalid clientKey' });
  }

  // Optional ?route=... query param to pick which rule to query against.
  // Defaults to "/" so this endpoint always returns something even without it.
  const route = typeof req.query.route === 'string' ? req.query.route : '/';

  const parsed = parseClientKey(clientKey);
  if (!parsed) {
    return res
      .status(400)
      .json({ error: 'clientKey must be of form "type:value" with type in {ip, api_key, user_id}' });
  }

  try {
    const rules = await listEnabledRules();
    const rule = findBestRule(rules, route, parsed.type);
    if (!rule) {
      return res.status(404).json({ error: 'No matching rule for route', route });
    }

    const count = await getCurrentCount(clientKey, rule.routePattern, rule.windowSeconds);
    return res.status(200).json({
      clientKey,
      route,
      routePattern: rule.routePattern,
      windowSeconds: rule.windowSeconds,
      requestCount: count,
      limit: rule.limitCount,
      remaining: Math.max(0, rule.limitCount - count),
      resetAt: Math.ceil((Date.now() + rule.windowSeconds * 1000) / 1000),
    });
  } catch (err) {
    console.error('stats handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
