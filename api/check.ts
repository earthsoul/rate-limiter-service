import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findBestRule, parseClientKey } from '../lib/matcher.js';
import { checkSlidingWindow } from '../lib/redis.js';
import type { CheckRequest, Rule } from '../lib/types.js';

/**
 * TEMPORARY: rules will come from Postgres once lib/db.ts exists (step 17).
 * For now we hardcode one so we can prove the end-to-end wiring works
 * without dragging the DB layer in yet.
 *
 * Default rule: 5 requests per 30s, keyed by IP, against /api/test.
 * Matches the example in README's "Quick demo" section.
 */
const HARDCODED_RULES: Rule[] = [
  {
    id: 'hardcoded-1',
    routePattern: '/api/test',
    clientKeyType: 'ip',
    limitCount: 5,
    windowSeconds: 30,
    strategy: 'sliding_window',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

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
    // 5. Find the most-specific rule that applies (against hardcoded list for now).
    const rule = findBestRule(HARDCODED_RULES, body.route, parsed.type);

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
