import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listEnabledRules } from '../../lib/db.js';
import { findBestRule, parseClientKey } from '../../lib/matcher.js';
import { getCurrentCount } from '../../lib/redis.js';
import type { StatsResult } from '../../lib/types.js';

/**
 * GET /api/stats/<clientKey>?route=<route>
 *
 * Read-only view of how much of its budget a client has spent in the
 * current window for a given route. Reuses the SAME rule-selection
 * pipeline as /api/check (listEnabledRules -> findBestRule) so the
 * two endpoints can never disagree about which rule governs a request.
 *
 * Critical property: hitting this endpoint must NOT increment any
 * counter. That's why we call getCurrentCount() (zremrangebyscore +
 * zcard only) and not checkSlidingWindow() (which also zadds).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const clientKeyRaw = req.query.clientKey;
  const routeRaw = req.query.route;

  if (typeof clientKeyRaw !== 'string' || clientKeyRaw.length === 0) {
    return res.status(400).json({
      error: 'invalid_input',
      message: 'clientKey path segment required',
    });
  }
  if (typeof routeRaw !== 'string' || routeRaw.length === 0) {
    return res.status(400).json({
      error: 'invalid_input',
      message: 'route query param required (e.g. ?route=/api/test)',
    });
  }

  const parsed = parseClientKey(clientKeyRaw);
  if (!parsed) {
    return res.status(400).json({
      error: 'invalid_input',
      message: 'clientKey must be of form "type:value" with type in {ip, api_key, user_id}',
    });
  }

  try {
    const rules = await listEnabledRules();
    const rule = findBestRule(rules, routeRaw, parsed.type);

    // No rule -> not tracked. 200, not 404: the absence of a rule is
    // a meaningful answer ("there's no governance on this route") that
    // a frontend may want to render directly.
    if (!rule) {
      const body: StatsResult = {
        clientKey: clientKeyRaw,
        route: routeRaw,
        routePattern: null,
        windowSeconds: 0,
        requestCount: 0,
        limit: -1,
        remaining: -1,
        resetAt: 0,
        message: 'No matching rule -- usage not tracked',
      };
      return res.status(200).json(body);
    }

    // The whole point of this endpoint: read the count, don't add to it.
    const count = await getCurrentCount(clientKeyRaw, rule.routePattern, rule.windowSeconds);

    // resetAt approximation: when a request arriving now would expire.
    // For a sliding window there's no clean single "reset" instant -- the
    // oldest entry will drop off first. This upper-bound is consistent
    // with what /api/check reports and is what most clients want.
    const resetAt = Date.now() + rule.windowSeconds * 1000;

    const body: StatsResult = {
      clientKey: clientKeyRaw,
      route: routeRaw,
      routePattern: rule.routePattern,
      windowSeconds: rule.windowSeconds,
      requestCount: count,
      limit: rule.limitCount,
      remaining: Math.max(0, rule.limitCount - count),
      resetAt,
    };
    return res.status(200).json(body);
  } catch (err) {
    console.error('GET /api/stats/[clientKey] failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
