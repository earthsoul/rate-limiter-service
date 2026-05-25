import assert from 'node:assert/strict';
import { getSql, listRules, listEnabledRules } from '../../lib/db.js';

// --- listRules() returns an array (may be empty) -----------------------------
const all = await listRules();
console.log(`listRules() -> ${all.length} rule(s)`);
assert.ok(Array.isArray(all), 'should return an array');

// --- listEnabledRules() returns an array of only enabled rules ---------------
const enabled = await listEnabledRules();
console.log(`listEnabledRules() -> ${enabled.length} rule(s)`);
assert.ok(Array.isArray(enabled), 'should return an array');
assert.ok(
  enabled.every((r) => r.enabled === true),
  'every row should have enabled === true (proves the WHERE clause works)'
);

// --- enabled rules must be a subset of all rules -----------------------------
const allIds = new Set(all.map((r) => r.id));
assert.ok(
  enabled.every((r) => allIds.has(r.id)),
  'every enabled rule should also appear in the full list'
);

// --- if any rows exist, check the shape matches our Rule type ---------------
if (all.length > 0) {
  const r = all[0]!;
  console.log('\nFirst row (camelCase, post-toRule):');
  console.log(JSON.stringify(r, null, 2));
  assert.equal(typeof r.id, 'string');
  assert.equal(typeof r.routePattern, 'string');
  assert.equal(typeof r.limitCount, 'number');
  assert.equal(typeof r.windowSeconds, 'number');
  assert.equal(typeof r.enabled, 'boolean');
}

console.log('\nAll list-query assertions passed.');

// Close the connection pool so the script can exit. Without this the
// postgres library keeps the event loop alive (idle connections in the pool).
await getSql().end();
