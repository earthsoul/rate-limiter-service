import { Redis } from '@upstash/redis';

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
