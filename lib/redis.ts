import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

// Module-level cache for the client. Underscore = private to this file.
let _redis: Redis | null = null;

/**
 * Returns a shared Upstash Redis client.
 *
 * Created lazily on first call (so importing this file doesn't require env
 * vars to be present), then reused for the rest of the process lifetime.
 * Each serverless invocation re-imports the module, so "process lifetime"
 * here means "this single warm function instance".
 */
export function getRedis(): Redis {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN. ' +
        'Set them in your .env file or Vercel project settings.'
    );
  }

  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Build the Redis cache key for a (clientKey, routePattern) pair.
 * Centralised in one place so the format never drifts.
 *
 *   buildKey('ip:1.2.3.4', '/api/v1/*')  →  'rl:ip:1.2.3.4:/api/v1/*'
 */
export function buildKey(clientKey: string, routePattern: string): string {
  return `rl:${clientKey}:${routePattern}`;
}

export interface SlidingWindowParams {
  clientKey: string;
  routePattern: string;
  limit: number;
  windowSeconds: number;
}

export interface SlidingWindowResult {
  allowed: boolean;
  count: number;       // requests in the window AFTER recording this one
  remaining: number;   // limit - count, floored at 0
  resetAt: number;     // unix seconds: conservative estimate (now + windowSeconds)
}

/**
 * Sliding-window rate-limit check.
 *
 * Each (clientKey, routePattern) pair owns a Redis sorted set whose members
 * are individual requests, scored by their timestamp in milliseconds.
 *
 * We pipeline 4 commands so the whole check is ONE HTTP round trip to Upstash:
 *
 *   1. ZREMRANGEBYSCORE   drop entries older than (now - windowMs)
 *   2. ZADD               record this request with score = now
 *   3. ZCARD              count what's left in the set
 *   4. EXPIRE             auto-clean the key when the client goes silent
 *
 * Each member is `<now>-<uuid>` so two requests in the same millisecond
 * don't collapse into one entry (sorted sets reject duplicate members).
 *
 * NOTE: this step only handles the happy path. On a denial the request is
 * still counted (we added it in step 2). Step 7 will back that out and
 * compute an accurate retryAfter from the oldest entry's score.
 */
export async function checkSlidingWindow(p: SlidingWindowParams): Promise<SlidingWindowResult> {
  const redis = getRedis();
  const now = Date.now();
  const windowMs = p.windowSeconds * 1000;
  const cutoff = now - windowMs;
  const key = buildKey(p.clientKey, p.routePattern);
  const member = `${now}-${randomUUID()}`;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, cutoff);
  pipe.zadd(key, { score: now, member });
  pipe.zcard(key);
  pipe.expire(key, p.windowSeconds);
  const results = (await pipe.exec()) as [number, number, number, number];
  const count = results[2];

  return {
    allowed: count <= p.limit,
    count,
    remaining: Math.max(0, p.limit - count),
    resetAt: Math.ceil((now + windowMs) / 1000),
  };
}
