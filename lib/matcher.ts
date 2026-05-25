import type { ClientKeyType, Rule } from './types.js';

/**
 * Returns true if `route` matches the glob-style `pattern`.
 *
 *   `*`  matches one path segment (no `/`)
 *   `**` matches any sequence of characters (including `/`)
 *
 * Anything else is matched literally.
 */
export function matches(pattern: string, route: string): boolean {
  if (pattern === route) return true; // fast path for exact match
  return patternToRegex(pattern).test(route);
}

function patternToRegex(pattern: string): RegExp {
  // 1. Escape regex metacharacters except `*` and `/`.
  //    Without this, a literal `.` in a route would match anything.
  let regex = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

  // 2. Stash `**` behind a placeholder so the single-`*` replacement
  //    in step 3 doesn't accidentally eat the second star.
  regex = regex.replace(/\*\*/g, '__DOUBLESTAR__');

  // 3. `*` → "one or more characters that aren't a slash"
  regex = regex.replace(/\*/g, '[^/]+');

  // 4. Restore `**` as `.*` — any sequence including slashes.
  regex = regex.replace(/__DOUBLESTAR__/g, '.*');

  // 5. Anchor so the WHOLE route must match, not a substring.
  return new RegExp(`^${regex}$`);
}

/**
 * Numeric specificity score: higher = more specific.
 * Used to pick a single winning rule when multiple patterns match the same route.
 *
 *   - Exact pattern (no `*`)            → MAX_SAFE_INTEGER (always wins)
 *   - Longer literal prefix before `*`  → higher score
 *   - At the same position, `*` beats `**`
 */
export function specificity(pattern: string): number {
  const firstStar = pattern.indexOf('*');
  if (firstStar === -1) return Number.MAX_SAFE_INTEGER;
  const hasDoubleStar = pattern.includes('**');
  return firstStar * 2 + (hasDoubleStar ? 0 : 1);
}

/**
 * Parses a client key of the form "type:value" into its parts.
 * Returns null if the input is malformed or the type is not recognised.
 *
 *   parseClientKey("ip:103.21.44.1")           → { type: 'ip', value: '103.21.44.1' }
 *   parseClientKey("api_key:eyJhbGc:OiJIUz")  → { type: 'api_key', value: 'eyJhbGc:OiJIUz' }
 *   parseClientKey("garbage")                  → null
 *   parseClientKey(":missing-type")            → null
 *   parseClientKey("ip:")                      → null
 */
export function parseClientKey(clientKey: string): { type: ClientKeyType; value: string } | null {
  // Split on the FIRST colon only -- the value itself may contain colons (e.g. a JWT).
  const idx = clientKey.indexOf(':');
  if (idx <= 0 || idx === clientKey.length - 1) return null;

  const type = clientKey.slice(0, idx);
  const value = clientKey.slice(idx + 1);

  // Narrow to ClientKeyType so callers get a typed result back.
  if (type !== 'ip' && type !== 'api_key' && type !== 'user_id') return null;

  return { type, value };
}

/**
 * Pick the single most-specific rule that applies to this request.
 * A rule applies only if:
 *   - it is enabled,
 *   - its clientKeyType matches the request's client type, AND
 *   - its routePattern matches the incoming route.
 *
 * Returns null when no rule applies (caller should treat as "allow by default").
 *
 * Filter THEN sort: if 1000 rules are in the DB and only 3 match, we
 * only sort 3 items, not 1000.
 */
export function findBestRule(rules: Rule[], route: string, clientKeyType: ClientKeyType): Rule | null {
  const matching = rules
    .filter((r) => r.enabled && r.clientKeyType === clientKeyType && matches(r.routePattern, route))
    .sort((a, b) => specificity(b.routePattern) - specificity(a.routePattern));
  return matching[0] ?? null;
}
