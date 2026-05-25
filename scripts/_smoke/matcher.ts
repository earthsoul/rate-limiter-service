import assert from 'node:assert/strict';
import { findBestRule, matches, parseClientKey, specificity } from '../../lib/matcher.js';
import type { Rule } from '../../lib/types.js';

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: 'test',
    routePattern: '/',
    clientKeyType: 'ip',
    limitCount: 10,
    windowSeconds: 60,
    strategy: 'sliding_window',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const cases: Array<[pattern: string, route: string, expected: boolean]> = [
  ['/api/v1/search', '/api/v1/search', true], // exact
  ['/api/v1/search', '/api/v1/other', false], // exact mismatch
  ['/api/v1/*', '/api/v1/search', true], // single-star matches one segment
  ['/api/v1/*', '/api/v1/search/foo', false], // single-star stops at /
  ['/api/v1/*', '/api/v1/', false], // single-star needs ≥1 char
  ['/api/**', '/api/v1/search/foo', true], // double-star spans /
  ['/api/**', '/api/', true], // ** matches empty
  ['/files/*.json', '/files/data.json', true], // literal `.` doesn't match anything
  ['/files/*.json', '/files/dataxjson', false], //   ^ proves the `.` was escaped
];

let passed = 0;
for (const [pattern, route, expected] of cases) {
  const actual = matches(pattern, route);
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  matches(${JSON.stringify(pattern)}, ${JSON.stringify(route)}) → ${actual}`);
  assert.equal(actual, expected, `expected ${expected}, got ${actual}`);
  passed++;
}
console.log(`\n${passed}/${cases.length} matcher cases passed.\n`);

// --- specificity() -----------------------------------------------------------
// Most-specific wins. Sort competing patterns descending and check the winner.
const competing = ['/api/**', '/api/v1/*', '/api/v1/search'];
const ranked = [...competing].sort((a, b) => specificity(b) - specificity(a));
console.log('Ranked by specificity (most → least):');
for (const p of ranked) console.log(`  ${specificity(p).toString().padStart(20)}  ${p}`);

assert.deepEqual(ranked, ['/api/v1/search', '/api/v1/*', '/api/**'], 'exact > single-star > double-star');
assert.equal(specificity('/api/v1/search'), Number.MAX_SAFE_INTEGER, 'exact match maxed out');
assert.ok(specificity('/api/v1/*') > specificity('/api/*'), 'longer literal prefix wins');
assert.ok(specificity('/api/*') > specificity('/api/**'), 'single-star beats double-star at same position');
console.log('\nAll specificity assertions passed.\n');

// --- parseClientKey() --------------------------------------------------------
assert.deepEqual(parseClientKey('ip:103.21.44.1'), { type: 'ip', value: '103.21.44.1' });
assert.deepEqual(parseClientKey('user_id:abc123'), { type: 'user_id', value: 'abc123' });
// JWT-style value contains a colon -- the value must be preserved intact.
assert.deepEqual(
  parseClientKey('api_key:eyJhbGc:OiJIUz'),
  { type: 'api_key', value: 'eyJhbGc:OiJIUz' },
  'split on first colon only'
);
// Garbage cases all return null.
assert.equal(parseClientKey('garbage'), null, 'no colon');
assert.equal(parseClientKey(':missing-type'), null, 'empty type');
assert.equal(parseClientKey('ip:'), null, 'empty value');
assert.equal(parseClientKey('unknown_type:foo'), null, 'unrecognised type');
console.log('All parseClientKey assertions passed.\n');

// --- findBestRule() ----------------------------------------------------------

// 1. Empty list -> null
assert.equal(findBestRule([], '/api/v1/search', 'ip'), null, 'empty rules -> null');

// 2. No rule matches the route -> null
assert.equal(
  findBestRule([makeRule({ routePattern: '/other' })], '/api/v1/search', 'ip'),
  null,
  'no pattern match -> null'
);

// 3. Multiple matching rules -> most specific wins
const rules = [
  makeRule({ id: 'broad', routePattern: '/api/**' }),
  makeRule({ id: 'mid', routePattern: '/api/v1/*' }),
  makeRule({ id: 'exact', routePattern: '/api/v1/search' }),
];
const winner = findBestRule(rules, '/api/v1/search', 'ip');
assert.equal(winner?.id, 'exact', 'most specific should win');

// 4. Disabled rules are skipped even if their pattern matches
const onlyDisabled = [makeRule({ id: 'off', routePattern: '/api/v1/search', enabled: false })];
assert.equal(findBestRule(onlyDisabled, '/api/v1/search', 'ip'), null, 'disabled rule must not win');

// 5. Wrong client-key type is skipped (same pattern, different audience)
const twoAudiences = [
  makeRule({ id: 'for_ip', routePattern: '/api/**', clientKeyType: 'ip', limitCount: 100 }),
  makeRule({ id: 'for_key', routePattern: '/api/**', clientKeyType: 'api_key', limitCount: 1000 }),
];
const ipWinner = findBestRule(twoAudiences, '/api/users', 'ip');
const keyWinner = findBestRule(twoAudiences, '/api/users', 'api_key');
assert.equal(ipWinner?.id, 'for_ip', 'ip request -> ip rule');
assert.equal(keyWinner?.id, 'for_key', 'api_key request -> api_key rule');

console.log('All findBestRule assertions passed.');
