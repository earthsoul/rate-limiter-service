import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listEnabledRules } from '../lib/db.js';
import { findBestRule, parseClientKey } from '../lib/matcher.js';
import { checkSlidingWindow } from '../lib/redis.js';
import type { CheckRequest } from '../lib/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as Partial<CheckRequest> | undefined;
  if (!body || typeof body.route !== 'string' || typeof body.clientKey !== 'string') {
    return res.status(400).json({ error: 'Missing required fields: route (string), clientKey (string)' });
  }

  const parsed = parseClientKey(body.clientKey);
  if (!parsed) {
    return res
      .status(400)
      .json({ error: 'clientKey must be of form "type:value" with type in {ip, api_key, user_id}' });
  }

  try {
    const rules = await listEnabledRules();
    const rule = findBestRule(rules, body.route, parsed.type);

    if (!rule) {
      // No matching rule → allow by default. Useful for staged rollout.
      return res.status(200).json({
        allowed: true,
        remaining: -1,
        limit: -1,
        windowSeconds: 0,
        resetAt: 0,
        message: 'No matching rule — allowed by default',
      });
    }

    const result = await checkSlidingWindow({
      clientKey: body.clientKey,
      routePattern: rule.routePattern,
      limit: rule.limitCount,
      windowSeconds: rule.windowSeconds,
    });

    res.setHeader('X-RateLimit-Limit', String(rule.limitCount));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetAt));

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
