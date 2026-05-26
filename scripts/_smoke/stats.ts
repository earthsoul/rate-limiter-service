import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import checkHandler from '../../api/check.js';
import statsHandler from '../../api/stats/[clientKey].js';
import { getSql } from '../../lib/db.js';
import type { CheckResult, StatsResult } from '../../lib/types.js';

interface Captured {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function mockRes() {
  const captured: Captured = { statusCode: 0, body: undefined, headers: {} };
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
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, captured };
}

async function callStats(method: string, clientKey: string, query: Record<string, string> = {}) {
  const { res, captured } = mockRes();
  const req = { method, query: { clientKey, ...query } } as unknown as Parameters<typeof statsHandler>[0];
  await statsHandler(req, res as unknown as Parameters<typeof statsHandler>[1]);
  return captured;
}

async function callCheck(clientKey: string, route: string) {
  const { res, captured } = mockRes();
  const req = { method: 'POST', body: { clientKey, route } } as unknown as Parameters<typeof checkHandler>[0];
  await checkHandler(req, res as unknown as Parameters<typeof checkHandler>[1]);
  return captured;
}

// Brand-new client key so we start with a fresh budget.
const CLIENT = `ip:198.51.100.${Math.floor(Math.random() * 200) + 10}`;
const ROUTE = '/api/test';

console.log(`Using client key: ${CLIENT}`);

// --- 1. OPTIONS -> 204 -----------------------------------------------------
{
  const r = await callStats('OPTIONS', CLIENT, { route: ROUTE });
  assert.equal(r.statusCode, 204);
  console.log('OPTIONS -> 204 OK');
}

// --- 2. POST -> 405 with Allow ---------------------------------------------
{
  const r = await callStats('POST', CLIENT, { route: ROUTE });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers['Allow'], 'GET, OPTIONS');
  console.log('POST -> 405 with Allow OK');
}

// --- 3. Bad clientKey -> 400 -----------------------------------------------
{
  const r = await callStats('GET', 'no-colon-here', { route: ROUTE });
  assert.equal(r.statusCode, 400);
  console.log('GET (bad clientKey) -> 400 OK');
}

// --- 4. Missing route query param -> 400 -----------------------------------
{
  const r = await callStats('GET', CLIENT);
  assert.equal(r.statusCode, 400);
  console.log('GET (no route) -> 400 OK');
}

// --- 5. Initial stats -> 0 (fresh client, never checked) -------------------
{
  const r = await callStats('GET', CLIENT, { route: ROUTE });
  assert.equal(r.statusCode, 200);
  const s = r.body as StatsResult;
  assert.equal(s.requestCount, 0, 'fresh client should have 0 requests');
  assert.equal(s.limit, 5);
  assert.equal(s.remaining, 5);
  assert.equal(s.routePattern, '/api/test');
  console.log(`initial stats -> requestCount=0, remaining=5 OK`);
}

// --- 6. Spend 2 via /check -------------------------------------------------
for (let i = 1; i <= 2; i++) {
  const r = await callCheck(CLIENT, ROUTE);
  assert.equal(r.statusCode, 200);
  const c = r.body as CheckResult;
  assert.equal(c.allowed, true);
  console.log(`check #${i} -> remaining=${c.remaining}`);
}

// --- 7. Stats now -> 2 -----------------------------------------------------
{
  const r = await callStats('GET', CLIENT, { route: ROUTE });
  const s = r.body as StatsResult;
  assert.equal(s.requestCount, 2, `after 2 checks, stats should report 2 (got ${s.requestCount})`);
  assert.equal(s.remaining, 3);
  console.log(`stats after 2 checks -> requestCount=2 OK`);
}

// --- 8. Stats N more times -- count must NOT change (read-only property) --
for (let i = 1; i <= 3; i++) {
  const r = await callStats('GET', CLIENT, { route: ROUTE });
  const s = r.body as StatsResult;
  assert.equal(s.requestCount, 2, `stats call #${i} must not increment (got ${s.requestCount})`);
}
console.log('3 more stats calls -> still requestCount=2 (read-only verified) OK');

// --- 9. One more /check -> spend 1 more -----------------------------------
{
  const r = await callCheck(CLIENT, ROUTE);
  assert.equal(r.statusCode, 200);
  const c = r.body as CheckResult;
  assert.equal(c.allowed, true);
  console.log(`check #3 -> remaining=${c.remaining}`);
}

// --- 10. Stats -> 3 --------------------------------------------------------
{
  const r = await callStats('GET', CLIENT, { route: ROUTE });
  const s = r.body as StatsResult;
  assert.equal(s.requestCount, 3, `after 1 more check, stats should report 3 (got ${s.requestCount})`);
  assert.equal(s.remaining, 2);
  console.log(`stats after 3rd check -> requestCount=3 OK`);
}

// --- 11. Stats for an unconfigured route -> 200 with sentinels -------------
{
  const r = await callStats('GET', CLIENT, { route: `/nothing/${randomUUID()}` });
  assert.equal(r.statusCode, 200);
  const s = r.body as StatsResult;
  assert.equal(s.requestCount, 0);
  assert.equal(s.limit, -1);
  assert.equal(s.remaining, -1);
  assert.equal(s.routePattern, null);
  assert.ok(s.message?.includes('not tracked'));
  console.log('stats (no matching rule) -> 200 with sentinels OK');
}

console.log('\nAll stats assertions passed.');
await getSql().end();
