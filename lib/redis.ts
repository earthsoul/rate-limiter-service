import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN. Set them in your .env file or Vercel project settings.'
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

export interface SlidingWindowParams {
  clientKey: string;
  routePattern: string;
  limit: number;
  windowSeconds: number;
}

export interface SlidingWindowResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Sliding-window rate limit check, implemented as a single Upstash REST pipeline:
 *   1. ZREMRANGEBYSCORE  — drop entries older than (now - windowMs)
 *   2. ZADD              — add this request with score = now
 *   3. ZCARD             — count entries in the current window (incl. this one)
 *   4. EXPIRE            — TTL so the key auto-cleans when idle
 *
 * If the count exceeds the limit we back out our ZADD and fetch the oldest score
 * to compute an accurate `retryAfter`. Done as a second call only on denials.
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

  // Denied. Back out our entry (best effort) and look up the oldest score
  // so the caller can return a meaningful Retry-After.
  const [, oldest] = await Promise.all([
    redis.zrem(key, member),
    redis.zrange(key, 0, 0, { withScores: true }) as Promise<(string | number)[]>,
  ]);

  let retryAfter = p.windowSeconds;
  if (Array.isArray(oldest) && oldest.length >= 2) {
    const oldestScore = Number(oldest[1]);
    if (Number.isFinite(oldestScore)) {
      retryAfter = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    }
  }

  return {
    allowed: false,
    count: count - 1,
    remaining: 0,
    resetAt: Math.ceil((now + retryAfter * 1000) / 1000),
    retryAfter,
  };
}

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

function buildKey(clientKey: string, routePattern: string): string {
  return `rl:${clientKey}:${routePattern}`;
}
