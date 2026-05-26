import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import handler from '../../api/rules/index.js';
import { deleteRule, getSql } from '../../lib/db.js';
import type { Rule } from '../../lib/types.js';

// Minimal mock of the VercelRequest/Response surface our handler uses.
// We don't need the whole shape -- just enough to capture status, headers,
// and the JSON body the handler tries to send.
function mockReq(method: string, body?: unknown) {
  return { method, body } as Parameters<typeof handler>[0];
}

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function mockRes(): {
  res: Parameters<typeof handler>[1];
  captured: CapturedResponse;
} {
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

async function call(method: string, body?: unknown) {
  const { res, captured } = mockRes();
  await handler(mockReq(method, body), res);
  return captured;
}

// --- OPTIONS preflight -> 204 ----------------------------------------------
{
  const r = await call('OPTIONS');
  assert.equal(r.statusCode, 204, 'OPTIONS should return 204');
  assert.equal(r.body, undefined, 'OPTIONS should have no body');
  console.log('OPTIONS -> 204 OK');
}

// --- PUT (not allowed) -> 405 with Allow header ----------------------------
{
  const r = await call('PUT');
  assert.equal(r.statusCode, 405, 'PUT should return 405');
  assert.equal(r.headers['Allow'], 'GET, POST, OPTIONS', 'Allow header required by RFC');
  console.log('PUT -> 405 with Allow header OK');
}

// --- POST with various invalid bodies all return 400 -----------------------
const invalidBodies: Array<[string, unknown]> = [
  ['null body', null],
  ['missing routePattern', { clientKeyType: 'ip', limitCount: 10, windowSeconds: 60 }],
  ['routePattern wrong type', { routePattern: 42, clientKeyType: 'ip', limitCount: 10, windowSeconds: 60 }],
  ['bad clientKeyType', { routePattern: '/a', clientKeyType: 'wrong', limitCount: 10, windowSeconds: 60 }],
  ['non-integer limitCount', { routePattern: '/a', clientKeyType: 'ip', limitCount: 1.5, windowSeconds: 60 }],
  ['zero windowSeconds', { routePattern: '/a', clientKeyType: 'ip', limitCount: 10, windowSeconds: 0 }],
  ['bad strategy', { routePattern: '/a', clientKeyType: 'ip', limitCount: 10, windowSeconds: 60, strategy: 'token_bucket' }],
  ['bad enabled type', { routePattern: '/a', clientKeyType: 'ip', limitCount: 10, windowSeconds: 60, enabled: 'yes' }],
];
for (const [label, body] of invalidBodies) {
  const r = await call('POST', body);
  assert.equal(r.statusCode, 400, `POST ${label} -> should be 400`);
  const errBody = r.body as { error: string; message: string };
  assert.equal(errBody.error, 'invalid_input');
  assert.ok(errBody.message.length > 0, 'should include a useful message');
  console.log(`POST ${label} -> 400 (${errBody.message}) OK`);
}

// --- POST with valid body -> 201 and the new rule --------------------------
const TEST_PATTERN = `/smoke-test/${randomUUID()}`;
const created = await call('POST', {
  routePattern: TEST_PATTERN,
  clientKeyType: 'ip',
  limitCount: 7,
  windowSeconds: 42,
});
assert.equal(created.statusCode, 201, 'POST valid -> 201');
const createdRule = (created.body as { rule: Rule }).rule;
assert.equal(createdRule.routePattern, TEST_PATTERN);
assert.equal(createdRule.limitCount, 7);
assert.equal(createdRule.windowSeconds, 42);
assert.equal(createdRule.strategy, 'sliding_window');
assert.equal(createdRule.enabled, true);
console.log(`POST valid -> 201, id=${createdRule.id} OK`);

// --- GET -> includes the rule we just created ------------------------------
const listed = await call('GET');
assert.equal(listed.statusCode, 200);
const rules = (listed.body as { rules: Rule[] }).rules;
assert.ok(Array.isArray(rules), 'GET should return { rules: [...] }');
assert.ok(rules.some((r) => r.id === createdRule.id), 'GET should include the rule we just created');
console.log(`GET -> 200, found ${rules.length} rule(s) including ours OK`);

// --- Cleanup so the table is back to empty for the next step ---------------
await deleteRule(createdRule.id);
console.log('cleanup OK');

console.log('\nAll rules-index assertions passed.');

await getSql().end();
