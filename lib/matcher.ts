import type { ClientKeyType, Rule } from './types.js';

/**
 * Matches a glob-style route pattern against a concrete route.
 *   `*`  matches a single path segment (no `/`)
 *   `**` matches any sequence of characters (including `/`)
 *
 * Examples:
 *   matches('/api/v1/*',  '/api/v1/search')      -> true
 *   matches('/api/v1/*',  '/api/v1/search/foo')  -> false
 *   matches('/api/**',    '/api/v1/search/foo')  -> true
 *   matches('/api/users', '/api/users')          -> true
 */
export function matches(pattern: string, route: string): boolean {
  if (pattern === route) return true;
  return patternToRegex(pattern).test(route);
}

function patternToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except `*` and `/`.
  let regex = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  // Use a placeholder for `**` so the single-`*` replacement doesn't touch it.
  regex = regex.replace(/\*\*/g, '__DOUBLESTAR__');
  regex = regex.replace(/\*/g, '[^/]+');
  regex = regex.replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp(`^${regex}$`);
}

/**
 * Returns a specificity score so the most specific pattern wins.
 *   - Exact pattern (no wildcards)  -> very high score
 *   - Longer prefix before first `*` -> higher score
 *   - `**` is treated as less specific than `*`
 */
export function specificity(pattern: string): number {
  const firstStar = pattern.indexOf('*');
  if (firstStar === -1) return 1_000_000 + pattern.length; // exact match
  const hasDoubleStar = pattern.includes('**');
  return firstStar * 10 + (hasDoubleStar ? 0 : 1);
}

/**
 * Parses a clientKey of the form `type:value` into its parts.
 * Returns null if the format is invalid.
 */
export function parseClientKey(clientKey: string): { type: ClientKeyType; value: string } | null {
  const idx = clientKey.indexOf(':');
  if (idx <= 0 || idx === clientKey.length - 1) return null;
  const type = clientKey.slice(0, idx);
  const value = clientKey.slice(idx + 1);
  if (type !== 'ip' && type !== 'api_key' && type !== 'user_id') return null;
  return { type, value };
}

/**
 * Pick the most-specific enabled rule that matches `route` and the client-key type.
 */
export function findBestRule(rules: Rule[], route: string, clientKeyType: ClientKeyType): Rule | null {
  const candidates = rules
    .filter((r) => r.enabled && r.clientKeyType === clientKeyType && matches(r.routePattern, route))
    .sort((a, b) => specificity(b.routePattern) - specificity(a.routePattern));
  return candidates[0] ?? null;
}
