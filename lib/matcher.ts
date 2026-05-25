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
