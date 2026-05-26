import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listEnabledRules } from '../lib/db.js';
import { findBestRule, parseClientKey } from '../lib/matcher.js';
import { checkSlidingWindow } from '../lib/redis.js';
import type { CheckRequest } from '../lib/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. CORS preflight -- browsers send OPTIONS before non-simple POSTs.
  if (req.method === 'OPTIONS') return res.status(204).end();

  // 2. Only POST is allowed on this endpoint.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 3. Body validation -- both fields required and must be strings.
  const body = req.body as Partial<CheckRequest> | undefined;
  if (!body || typeof body.route !== 'string' || typeof body.clientKey !== 'string') {
    return res
      .status(400)
      .json({ error: 'Missing required fields: route (string), clientKey (string)' });
  }

  // 4. Parse the clientKey into typed parts. Reject malformed input at the edge.
  const parsed = parseClientKey(body.clientKey);
  if (!parsed) {
    return res
      .status(400)
      .json({ error: 'clientKey must be of form "type:value" with type in {ip, api_key, user_id}' });
  }

  try {
    // 5. Fetch all enabled rules from Postgres on every request.
    //    Trade-off: ~5-15ms extra latency from fra1 to Supabase pooler
    //    in fra1. Acceptable for demo/low-traffic; the natural next step
    //    is an in-process TTL cache (30s) or Supabase Realtime
    //    invalidation. Deferred -- see README "future work".
    //
    //    Hits idx_rules_enabled, returns only enabled rules; disabled
    //    rules don't break traffic, they just stop being matched.
    const rules = await listEnabledRules();
    const rule = findBestRule(rules, body.route, parsed.type);

    // No rule matches -> allow by default. Lets teams opt-in routes to
    // rate limiting without breaking everything else they ship.
    if (!rule) {
      return res.status(200).json({
        allowed: true,
        remaining: -1,
        limit: -1,
        windowSeconds: 0,
        resetAt: 0,
        message: 'No matching rule -- allowed by default',
      });
    }

    // 6. Run the sliding-window check against Redis.
    const result = await checkSlidingWindow({
      clientKey: body.clientKey,
      routePattern: rule.routePattern,
      limit: rule.limitCount,
      windowSeconds: rule.windowSeconds,
    });

    // 7. Standard rate-limit headers on every response so clients can self-pace.
    res.setHeader('X-RateLimit-Limit', String(rule.limitCount));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetAt));

    // 8. 429 on deny, 200 on allow.
    if (!result.allowed) {
      const retryAfter = result.retryAfter ?? rule.windowSeconds;
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        allowed: false,
        remaining: 0,
        retryAfter,
        message: 'Rate limit exceeded',
      });
    }

    return res.status(200).json({
      allowed: true,
      remaining: result.remaining,
      limit: rule.limitCount,
      windowSeconds: rule.windowSeconds,
      resetAt: result.resetAt,
    });
  } catch (err) {
    console.error('check handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
