# Rate Limiter as a Service — Project Spec

## Project overview

A standalone rate limiting microservice deployed on Vercel. Exposes a `/api/check` decision API that tells callers whether a given request should be allowed or denied, based on configurable rules stored in Postgres. Sliding window counters are stored in Upstash (serverless Redis). Includes a mock upstream endpoint to demo the full flow end-to-end.

This is a portfolio project built to demonstrate:
- TypeScript + Node.js backend skills
- Distributed systems thinking (sliding window algorithm, Redis, Postgres)
- Serverless deployment on Vercel
- Clean REST API design

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Language | TypeScript + Node.js | Typed, modern, widely used at EU product companies |
| Runtime | Vercel serverless functions | Free hosting, instant live URL, no Docker needed |
| Counter store | Upstash (serverless Redis) | HTTP-based Redis, works in serverless functions, free tier |
| Rule store | Supabase Postgres (via `postgres` npm package + pooler URL) | Persistent rule config, generous free tier, great dashboard. Connect via the standard `postgres` driver over the pooler — no Supabase JS SDK bloat |
| Framework | No framework needed | Vercel handles routing via file system |

---

## Project structure

```
rate-limiter/
  api/                          ← Vercel auto-routes these as serverless functions
    rules/
      index.ts                  ← GET /api/rules, POST /api/rules
      [id].ts                   ← GET /api/rules/:id, DELETE /api/rules/:id
    check.ts                    ← POST /api/check  (main endpoint)
    stats/
      [clientKey].ts            ← GET /api/stats/:clientKey
    mock/
      [...path].ts              ← GET/POST /api/mock/* (mock upstream)
  lib/
    redis.ts                    ← Upstash client + sliding window logic
    db.ts                       ← Postgres client + rule queries
    matcher.ts                  ← Route pattern matching logic
    types.ts                    ← Shared TypeScript types
  scripts/
    migrate.ts                  ← Run DB migration (one-time setup)
  vercel.json
  tsconfig.json
  package.json
  README.md
```

---

## Environment variables

Set these in Vercel dashboard (Settings → Environment Variables) and in a local `.env` file for development. The `POSTGRES_URL` is the **Supabase pooler URL** (Transaction mode, port 6543) — grab it from Supabase → Settings → Database → Connection pooling:

```
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
POSTGRES_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

---

## Database schema (Postgres)

```sql
CREATE TABLE rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_pattern TEXT NOT NULL,         -- e.g. "/api/v1/*" or "/api/search"
  client_key_type TEXT NOT NULL,       -- "ip" | "api_key" | "user_id"
  limit_count INTEGER NOT NULL,        -- max requests allowed
  window_seconds INTEGER NOT NULL,     -- rolling window size in seconds
  strategy TEXT NOT NULL DEFAULT 'sliding_window',  -- "sliding_window" | "fixed_window"
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## API endpoints

### POST /api/check
The core endpoint. Pass a route and client key, get back an allow/deny decision.

**Request body:**
```json
{
  "route": "/api/v1/search",
  "clientKey": "ip:103.21.44.1"
}
```

**Response — allowed (200):**
```json
{
  "allowed": true,
  "remaining": 87,
  "limit": 100,
  "windowSeconds": 60,
  "resetAt": 1716394800
}
```

**Response — rate limited (429):**
```json
{
  "allowed": false,
  "remaining": 0,
  "retryAfter": 23,
  "message": "Rate limit exceeded"
}
```

Response headers on every request:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1716394800
Retry-After: 23        ← only on 429
```

---

### POST /api/rules
Create a new rate limit rule.

**Request body:**
```json
{
  "routePattern": "/api/v1/*",
  "clientKeyType": "ip",
  "limitCount": 100,
  "windowSeconds": 60,
  "strategy": "sliding_window"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "routePattern": "/api/v1/*",
  "clientKeyType": "ip",
  "limitCount": 100,
  "windowSeconds": 60,
  "strategy": "sliding_window",
  "enabled": true,
  "createdAt": "2026-05-22T10:00:00Z"
}
```

---

### GET /api/rules
List all rules. Returns array of rule objects.

### GET /api/rules/:id
Get a single rule by UUID.

### DELETE /api/rules/:id
Delete a rule. Returns `204 No Content`.

---

### GET /api/stats/:clientKey
Get current usage for a client key across all matching rules.

**Response (200):**
```json
{
  "clientKey": "ip:103.21.44.1",
  "windowSeconds": 60,
  "requestCount": 13,
  "limit": 100,
  "remaining": 87,
  "resetAt": 1716394800
}
```

---

### GET /api/mock/*
Mock upstream endpoint. Returns an echo of the request — used to demo the rate limiter end-to-end without needing a real upstream service.

**Response (200):**
```json
{
  "message": "Mock upstream response",
  "path": "/api/mock/search",
  "method": "GET",
  "timestamp": "2026-05-22T10:00:00Z",
  "headers": { ... }
}
```

---

## Core logic — sliding window algorithm

Implemented in `lib/redis.ts` using Upstash REST API.

### How it works:
1. Each request gets a Redis key: `rl:{clientKey}:{routePattern}`
2. Use a Redis sorted set where the score = timestamp (ms)
3. On each request:
   - `ZREMRANGEBYSCORE` — remove entries older than `now - windowSeconds * 1000`
   - `ZADD` — add current request with score = `Date.now()`
   - `ZCOUNT` — count entries in the current window
   - `EXPIRE` — set TTL to `windowSeconds` so keys clean up automatically
4. If count > limit → deny. Else → allow.

### Why sliding window over fixed window:
Fixed window resets at a fixed clock time (e.g. every minute on the minute). A user can send 100 requests at 00:59 and 100 more at 01:01 — 200 requests in 2 seconds, bypassing the limit. Sliding window counts requests in a true rolling window, preventing this burst exploit.

### Upstash pipeline (batch the Redis commands):
Use Upstash's pipeline API to send all 4 Redis commands in a single HTTP request. This is critical for performance in a serverless environment where each HTTP call has latency overhead.

---

## Route pattern matching logic (`lib/matcher.ts`)

Rules use glob-style route patterns. Matching priority:
1. Exact match first: `/api/v1/search` beats `/api/v1/*`
2. Then longest prefix wildcard: `/api/v1/*` beats `/api/*`
3. Wildcard `*` matches any single path segment
4. `**` matches multiple segments (optional to implement)

Example:
- Rule: `/api/v1/*`, clientKeyType: `ip`
- Incoming: route=`/api/v1/search`, clientKey=`ip:103.21.44.1`
- Match found → check counter for key `rl:ip:103.21.44.1:/api/v1/*`

---

## TypeScript types (`lib/types.ts`)

```typescript
export type ClientKeyType = 'ip' | 'api_key' | 'user_id';
export type Strategy = 'sliding_window' | 'fixed_window';

export interface Rule {
  id: string;
  routePattern: string;
  clientKeyType: ClientKeyType;
  limitCount: number;
  windowSeconds: number;
  strategy: Strategy;
  enabled: boolean;
  createdAt: string;
}

export interface CheckRequest {
  route: string;
  clientKey: string;
}

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  windowSeconds: number;
  resetAt: number;
  retryAfter?: number;
}
```

---

## vercel.json

```json
{
  "functions": {
    "api/**/*.ts": {
      "runtime": "@vercel/node"
    }
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET,POST,DELETE,OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type" }
      ]
    }
  ]
}
```

---

## package.json dependencies

```json
{
  "dependencies": {
    "@upstash/redis": "^1.x",
    "postgres": "^3.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "@vercel/node": "^3.x",
    "tsx": "^4.x"
  }
}
```

---

## Day-by-day build plan

### Day 1 — core logic

**Step 1 — Project init**
- Run `vercel init`, choose TypeScript
- Set up `tsconfig.json` (target ES2022, module NodeNext)
- Create folder structure as above
- Install dependencies

**Step 2 — Upstash setup**
- Create free Upstash account at upstash.com
- Create a Redis database (region: closest to you)
- Copy REST URL + token to `.env`
- Implement sliding window in `lib/redis.ts` using `@upstash/redis`
- Use pipeline to batch ZREMRANGEBYSCORE + ZADD + ZCOUNT + EXPIRE

**Step 3 — /api/check endpoint**
- Implement `lib/db.ts` with a `getRuleForRoute(route)` function (hardcode a test rule first, add Postgres later)
- Implement `lib/matcher.ts` for route pattern matching
- Implement `api/check.ts`: parse body → match rule → check counter → return decision + headers

**Step 4 — /api/mock endpoint**
- Implement `api/mock/[...path].ts`: echo request method, path, headers, timestamp
- Test full flow: POST /api/check → allowed → GET /api/mock/anything → mock response

---

### Day 2 — management + ship

**Step 5 — Supabase Postgres**
- Create a free project at supabase.com (choose the region closest to your Vercel functions)
- Settings → Database → Connection string → choose **Connection pooling** → **Transaction** mode (port 6543). Copy the URL.
- Paste it into `.env` and Vercel env vars as `POSTGRES_URL`. Replace `[password]` with your DB password.
- In `lib/db.ts`, connect with the standard `postgres` npm package — not the Supabase JS SDK. The pooler URL is a plain Postgres connection, so any pg driver works and you avoid the SDK bundle:
  ```ts
  import postgres from 'postgres';
  export const sql = postgres(process.env.POSTGRES_URL!, { prepare: false });
  ```
  > Set `prepare: false` because Supabase's pooler runs in transaction mode and doesn't support prepared statements.
- Write `scripts/migrate.ts` to run the CREATE TABLE migration (use the same `sql` client)
- Run migration: `npx tsx scripts/migrate.ts`
- Implement rule CRUD in `lib/db.ts`

**Step 6 — Rules API**
- Implement `api/rules/index.ts`: GET (list all) + POST (create)
- Implement `api/rules/[id].ts`: GET (single) + DELETE

**Step 7 — Stats endpoint**
- Implement `api/stats/[clientKey].ts`: query Redis for current count + compute remaining

**Step 8 — Deploy + README**
- Push to GitHub
- Connect repo to Vercel (vercel.com → Import Project)
- Set environment variables in Vercel dashboard
- Write README (see section below)

---

## README structure (important for recruiters)

```markdown
# Rate Limiter as a Service

Live demo: https://your-project.vercel.app

## What it does
A configurable rate limiting API. POST to /api/check with a route and client key 
to get an allow/deny decision. Rules are managed via a REST API.

## Quick demo (copy-paste these curl commands)

# 1. Create a rule: 5 requests per 30 seconds
curl -X POST https://your-project.vercel.app/api/rules \
  -H "Content-Type: application/json" \
  -d '{"routePattern":"/api/test","clientKeyType":"ip","limitCount":5,"windowSeconds":30,"strategy":"sliding_window"}'

# 2. Check if a request is allowed (run this 6 times fast)
curl -X POST https://your-project.vercel.app/api/check \
  -H "Content-Type: application/json" \
  -d '{"route":"/api/test","clientKey":"ip:123.45.67.89"}'

# First 5 calls → 200 { "allowed": true, "remaining": 4 }
# 6th call      → 429 { "allowed": false, "retryAfter": 28 }

## Architecture decisions

**Why Upstash for counters, Postgres for rules?**
Rules change infrequently and need to be durable — Postgres is the right tool.
Request counts change on every request and need sub-millisecond reads/writes — Redis is the right tool.
Upstash specifically because standard Redis uses persistent TCP connections which don't work in serverless functions.

**Why sliding window over fixed window?**
Fixed windows can be gamed: send 100 requests at :59 and 100 more at :01 — 200 requests in 2 seconds.
Sliding window counts requests in a true rolling window, preventing burst exploits.

**Why Vercel?**
Zero-config deployment, instant HTTPS, free tier. Each API route is an independent serverless function.

## Local development
...
```

---

## What to highlight when discussing this project in interviews

1. **The sliding window algorithm** — explain ZADD/ZCOUNT, why you use score=timestamp, and why you pipeline the commands
2. **Redis vs Postgres choice** — counters in Redis (ephemeral, fast), rules in Postgres (durable, relational)
3. **Serverless constraints** — why Upstash instead of standard Redis (no persistent TCP connections in serverless)
4. **Route pattern matching** — how priority works, why exact match beats wildcard
5. **The 429 + Retry-After pattern** — it's an HTTP standard, shows you know protocol semantics

---

## Out of scope (don't build these, mention them in README as "future work")

- Authentication on the management API (would add JWT/API key auth)
- Rate limit bursting (allow temporary spikes above the limit)
- Admin dashboard UI
- Webhook notifications when a client hits the limit
- Multi-region Redis replication
