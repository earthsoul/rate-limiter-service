import assert from 'node:assert/strict';

// Clear env BEFORE importing so the missing-env test is meaningful regardless
// of how this script gets invoked.
delete process.env.POSTGRES_URL;

const { getSql, toRule } = await import('../../lib/db.js');
type DbRule = Parameters<typeof toRule>[0];

// --- getSql() throws cleanly without POSTGRES_URL ----------------------------
assert.throws(() => getSql(), /POSTGRES_URL/, 'should mention the missing env var by name');
console.log('getSql throws cleanly without POSTGRES_URL OK');

// --- getSql() is a singleton -------------------------------------------------
// postgres() is lazy: it stores config and only opens a connection on the
// first actual query, so a fake URL is safe to pass here.
process.env.POSTGRES_URL = 'postgresql://user:pass@localhost:5432/db';
const s1 = getSql();
const s2 = getSql();
assert.equal(s1, s2, 'second call should return the cached instance, not a new one');
console.log('getSql is a singleton OK');

// --- toRule() maps every snake_case column to its camelCase counterpart ------
const row: DbRule = {
  id: 'abc-123',
  route_pattern: '/api/v1/*',
  client_key_type: 'ip',
  limit_count: 100,
  window_seconds: 60,
  strategy: 'sliding_window',
  enabled: true,
  created_at: new Date('2026-05-22T10:00:00Z'),
};
assert.deepEqual(toRule(row), {
  id: 'abc-123',
  routePattern: '/api/v1/*',
  clientKeyType: 'ip',
  limitCount: 100,
  windowSeconds: 60,
  strategy: 'sliding_window',
  enabled: true,
  createdAt: '2026-05-22T10:00:00.000Z',
});
console.log('toRule mapping OK');

console.log('\nAll db-setup assertions passed.');
