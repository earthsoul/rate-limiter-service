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
  count: number;       // requests in the window AFTER recording this one (denied requests are not counted)
  remaining: number;   // limit - count, floored at 0
  resetAt: number;     // unix seconds: when the next slot frees up
  retryAfter?: number; // seconds to wait before retrying, only present on denials
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
 * On the allowed path we pay ONE HTTP round trip (the 4-command pipeline).
 * On a denial we pay TWO -- the original pipeline plus a small follow-up
 * that backs out our ZADD and reads the oldest entry's score so we can
 * return an accurate retryAfter to the caller.
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

  if (count <= p.limit) {
    return {
      allowed: true,
      count,
      remaining: Math.max(0, p.limit - count),
      resetAt: Math.ceil((now + windowMs) / 1000),
    };
  }

  // Denied. Back out our ZADD so denials don't consume window slots, and
  // grab the oldest entry's score to compute when a slot will actually free up.
  // Both commands batched into a single pipeline -> one extra round trip total.
  const denyPipe = redis.pipeline();
  denyPipe.zrem(key, member);
  denyPipe.zrange(key, 0, 0, { withScores: true });
  const denyResults = (await denyPipe.exec()) as [number, (string | number)[]];
  const oldest = denyResults[1];

  // Fall back to the full window if we can't read the oldest entry for any reason
  // (e.g. another process just wiped the key). Conservative but safe.
  let retryAfter = p.windowSeconds;
  if (Array.isArray(oldest) && oldest.length >= 2) {
    const oldestScore = Number(oldest[1]);
    if (Number.isFinite(oldestScore)) {
      retryAfter = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    }
  }

  return {
    allowed: false,
    count: count - 1, // we backed out our own entry, so the surviving count is one less
    remaining: 0,
    resetAt: Math.ceil((now + retryAfter * 1000) / 1000),
    retryAfter,
  };
}

/**
 * Read-only sibling of checkSlidingWindow: count current requests in the
 * window WITHOUT recording a new one. Used by /api/stats so a status lookup
 * doesn't itself consume a slot.
 *
 * Two-command pipeline = one HTTP round trip:
 *   1. ZREMRANGEBYSCORE  evict stale entries (free housekeeping)
 *   2. ZCARD             count what survives
 */
export async function getCurrentCount(
  clientKey: string,
  routePattern: string,
  windowSeconds: number
): Promise<number> {
  const redis = getRedis();
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const key = buildKey(clientKey, routePattern);

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, cutoff);
  pipe.zcard(key);
  const results = (await pipe.exec()) as [number, number];
  return results[1];
}
