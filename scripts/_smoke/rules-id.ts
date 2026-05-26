import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import handler from '../../api/rules/[id].js';
import { createRule, getSql } from '../../lib/db.js';
import type { Rule } from '../../lib/types.js';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function mockRes() {
  const captured: CapturedResponse = { statusCode: 0, body: undefined, headers: {}, ended: false };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      captured.headers[name] = String(value);
      return res;
    },
    getHeader(name: string) {
      return captured.headers[name];
    },
    status(code: number) {
      captured.statusCode = code;
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      captured.body = b;
      captured.ended = true;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    },
  };
  return { res: res as unknown as Parameters<typeof handler>[1], captured };
}

async function call(method: string, id: string) {
  const { res, captured } = mockRes();
  const req = { method, query: { id } } as unknown as Parameters<typeof handler>[0];
  await handler(req, res);
  return captured;
}

// --- OPTIONS -> 204 ---------------------------------------------------------
{
  const r = await call('OPTIONS', randomUUID());
  assert.equal(r.statusCode, 204, 'OPTIONS should return 204');
  console.log('OPTIONS -> 204 OK');
}

// --- PATCH -> 405 with Allow header ----------------------------------------
{
  const r = await call('PATCH', randomUUID());
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers['Allow'], 'GET, DELETE, OPTIONS', 'Allow header required by RFC');
  console.log('PATCH -> 405 with Allow header OK');
}

// --- GET with non-UUID id -> 400 (short-circuits before Postgres) ---------
{
  const r = await call('GET', 'not-a-uuid');
  assert.equal(r.statusCode, 400, 'should reject malformed id at the edge');
  assert.equal((r.body as { error: string }).error, 'invalid_id');
  console.log('GET (bad id) -> 400 OK');
}

// --- GET with non-existent UUID -> 404 -------------------------------------
{
  const r = await call('GET', randomUUID());
  assert.equal(r.statusCode, 404);
  assert.equal((r.body as { error: string }).error, 'not_found');
  console.log('GET (no row) -> 404 OK');
}

// --- Seed a rule, then GET it ----------------------------------------------
const TEST_PATTERN = `/smoke-test/${randomUUID()}`;
const seeded = await createRule({
  routePattern: TEST_PATTERN,
  clientKeyType: 'ip',
  limitCount: 3,
  windowSeconds: 15,
});
console.log(`seeded rule id=${seeded.id}`);

{
  const r = await call('GET', seeded.id);
  assert.equal(r.statusCode, 200);
  const rule = (r.body as { rule: Rule }).rule;
  assert.deepEqual(rule, seeded, 'GET should return the seeded rule unchanged');
  console.log('GET (hit) -> 200 OK');
}

// --- DELETE -> 204, no body -------------------------------------------------
{
  const r = await call('DELETE', seeded.id);
  assert.equal(r.statusCode, 204, 'DELETE on existing -> 204');
  assert.equal(r.body, undefined, '204 must have no body');
  console.log('DELETE (hit) -> 204 OK');
}

// --- DELETE again -> 404 ----------------------------------------------------
{
  const r = await call('DELETE', seeded.id);
  assert.equal(r.statusCode, 404, 'DELETE on already-gone -> 404');
  console.log('DELETE (miss) -> 404 OK');
}

// --- GET after delete -> 404 -----------------------------------------------
{
  const r = await call('GET', seeded.id);
  assert.equal(r.statusCode, 404);
  console.log('GET (after delete) -> 404 OK');
}

console.log('\nAll rules-id assertions passed.');
await getSql().end();
