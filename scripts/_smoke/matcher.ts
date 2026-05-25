import assert from 'node:assert/strict';
import { matches, parseClientKey, specificity } from '../../lib/matcher.js';

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
console.log('All parseClientKey assertions passed.');
