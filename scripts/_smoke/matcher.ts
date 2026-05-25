import assert from 'node:assert/strict';
import { matches } from '../../lib/matcher.js';

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
console.log(`\n${passed}/${cases.length} matcher cases passed.`);
