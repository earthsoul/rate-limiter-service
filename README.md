# Rate Limiter as a Service

A configurable rate-limiting microservice deployed on Vercel. `POST /api/check` with a route and a client key and it tells you whether the request should be allowed or denied, based on rules stored in Postgres. Sliding-window counters live in Upstash (serverless Redis). A mock upstream endpoint is included to demo the full flow end-to-end.

> **Live demo:** _add your Vercel URL here after `vercel --prod`_

---

## What this project demonstrates

- TypeScript + Node.js on Vercel serverless functions
- Distributed-systems thinking: sliding-window algorithm in Redis, durable rule config in Postgres
- Clean REST API design with proper HTTP semantics (`429 Too Many Requests` + `Retry-After`, `X-RateLimit-*` headers)
- Pragmatic serverless choices: HTTP-based Redis (Upstash) because long-lived TCP connections don't survive serverless cold-starts; Postgres pooler in transaction mode for the same reason

---

## Tech stack

| Layer          | Technology                                                   | Why                                                                                                                                                              |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript + Node.js 20                                      | Typed, modern, widely used                                                                                                                                       |
| Runtime        | Vercel serverless functions (`@vercel/node`)                 | Free hosting, instant HTTPS, file-system routing                                                                                                                 |
| Counter store  | [Upstash](https://upstash.com/) (serverless Redis over HTTP) | Works in serverless functions (no persistent TCP), generous free tier                                                                                            |
| Rule store     | [Supabase](https://supabase.com/) Postgres via `postgres` npm | Durable rule config. Connected via the standard `postgres` driver against the Supabase **pooler** (port 6543, transaction mode) — no Supabase JS SDK bloat |

---

## API reference

### `POST /api/check`

The core endpoint. Returns an allow / deny decision.

**Request:**

```json
{
  "route": "/api/v1/search",
  "clientKey": "ip:103.21.44.1"
}
```

`clientKey` must be of the form `type:value` where `type` is one of `ip`, `api_key`, `user_id`.

**Response — allowed (`200 OK`):**

```json
{
  "allowed": true,
  "remaining": 87,
  "limit": 100,
  "windowSeconds": 60,
  "resetAt": 1716394800
}
```

**Response — rate limited (`429 Too Many Requests`):**

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
X-RateLimit-Limit:     100
X-RateLimit-Remaining: 87
X-RateLimit-Reset:     1716394800
Retry-After:           23      ← only on 429
```

If no rule matches the route, the request is allowed by default with `remaining: -1` (signals "ungoverned"). This makes staged rollout easy.

---

### Rule management

| Method | Path              | Description       |
| ------ | ----------------- | ----------------- |
| `GET`  | `/api/rules`      | List all rules    |
| `POST` | `/api/rules`      | Create a new rule |
| `GET`  | `/api/rules/:id`  | Get one rule      |
| `DELETE` | `/api/rules/:id`| Delete a rule     |

**Create payload:**

```json
{
  "routePattern": "/api/v1/*",
  "clientKeyType": "ip",
  "limitCount": 100,
  "windowSeconds": 60,
  "strategy": "sliding_window"
}
```

`strategy` and `enabled` are optional (default `sliding_window` and `true`).

---

### `GET /api/stats/:clientKey?route=...`

Current usage for a client key against the matching rule.

```json
{
  "clientKey": "ip:103.21.44.1",
  "route": "/api/v1/search",
  "routePattern": "/api/v1/*",
  "windowSeconds": 60,
  "requestCount": 13,
  "limit": 100,
  "remaining": 87,
  "resetAt": 1716394800
}
```

---

### `GET|POST /api/mock/*`

A mock upstream that echoes the request — used to demo the full flow end-to-end without needing a real backend.

---

## Quick demo (copy-paste curl)

```bash
BASE=https://your-project.vercel.app

# 1. Create a rule: 5 requests per 30 seconds, keyed by IP
curl -s -X POST "$BASE/api/rules" \
  -H "Content-Type: application/json" \
  -d '{"routePattern":"/api/test","clientKeyType":"ip","limitCount":5,"windowSeconds":30,"strategy":"sliding_window"}'

# 2. Check 6 times fast
for i in 1 2 3 4 5 6; do
  curl -s -X POST "$BASE/api/check" \
    -H "Content-Type: application/json" \
    -d '{"route":"/api/test","clientKey":"ip:123.45.67.89"}'
  echo
done

# First 5 calls -> 200 { "allowed": true, "remaining": 4..0 }
# 6th call     -> 429 { "allowed": false, "retryAfter": 28 }
```

---

## Architecture decisions

**Why Upstash for counters, Postgres for rules?**
Rules change infrequently and need to be durable, queryable and relational — Postgres is the right tool. Request counts change on every request and need sub-millisecond reads/writes — Redis is the right tool. **Upstash** specifically because standard Redis uses persistent TCP connections, which don't fit serverless functions (every cold start would re-handshake). Upstash exposes Redis over HTTP, so it works seamlessly.

**Why sliding window over fixed window?**
A fixed window resets at a clock boundary (e.g. every minute on the minute). A user can send 100 requests at `:59` and 100 more at `:01` — 200 requests in 2 seconds, bypassing the limit. A sliding window counts requests in a true rolling window, preventing that burst.

**How the sliding window works (in `lib/redis.ts`):**

Each `(clientKey, routePattern)` pair gets a Redis sorted set keyed `rl:{clientKey}:{routePattern}`, scored by request timestamp (ms). For every check we pipeline four commands in a single HTTP roundtrip:

1. `ZREMRANGEBYSCORE` — drop entries older than `now - windowMs`
2. `ZADD`             — insert this request with `score = now`
3. `ZCARD`            — count entries currently in the window
4. `EXPIRE`           — TTL so the key auto-cleans when idle

If the count is over the limit, we back out our `ZADD` and look up the oldest entry's score to produce an accurate `Retry-After`. Pipelining matters here: a serverless function pays the network round-trip cost on every Redis call, so doing four commands in one request keeps p50 latency low.

**Why the Supabase pooler with `prepare: false`?**
The pooler runs in transaction mode and doesn't support prepared statements. Disabling prepares avoids `prepared statement does not exist` errors. Using the pooler URL is essential — direct connections (port 5432) won't scale with serverless invocations.

**Why Vercel?**
Zero-config deployment, instant HTTPS, every API route is an independent serverless function. Free tier is generous enough for a portfolio project that will see real demo traffic.

---

## Route-pattern matching

Implemented in `lib/matcher.ts`:

- `*`  matches a single path segment (no `/`)
- `**` matches any sequence of characters

Priority: exact match → longest prefix before the first wildcard → single-star over double-star.

| Pattern        | `/api/v1/search` | `/api/v1/search/foo` |
| -------------- | ---------------- | -------------------- |
| `/api/v1/search` | ✅              | ❌                   |
| `/api/v1/*`     | ✅              | ❌                   |
| `/api/**`       | ✅              | ✅                   |

---

## Database schema

```sql
CREATE TABLE rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_pattern   TEXT NOT NULL,
  client_key_type TEXT NOT NULL,                    -- 'ip' | 'api_key' | 'user_id'
  limit_count     INTEGER NOT NULL,
  window_seconds  INTEGER NOT NULL,
  strategy        TEXT NOT NULL DEFAULT 'sliding_window',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_rules_enabled ON rules (enabled);
```

Run via `npm run migrate` (uses `tsx --env-file=.env scripts/migrate.ts`).

---

## Local development

**Prerequisites:** Node.js 20+, a free [Upstash](https://upstash.com/) Redis DB, a free [Supabase](https://supabase.com/) project.

```bash
# 1. Install deps
npm install

# 2. Create your env file
cp .env.example .env
# Fill in UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, POSTGRES_URL

# 3. Run the migration to create the rules table
npm run migrate

# 4. Start Vercel dev (auto-routes /api/* to the serverless handlers)
npm run dev
```

For `POSTGRES_URL`: in Supabase go to **Settings → Database → Connection pooling → Transaction (port 6543)**. Copy the URI and replace `[password]` with your DB password.

---

## Deploying to Vercel

```bash
# Once
npm i -g vercel
vercel login

# Link the project (or use the Vercel dashboard to import the GitHub repo)
vercel link

# Set environment variables in the Vercel dashboard:
#   UPSTASH_REDIS_REST_URL
#   UPSTASH_REDIS_REST_TOKEN
#   POSTGRES_URL

vercel --prod
```

---

## Project layout

```
rate-limiter/
├── api/                       ← Vercel auto-routes these as serverless functions
│   ├── check.ts               ← POST /api/check
│   ├── rules/
│   │   ├── index.ts           ← GET, POST /api/rules
│   │   └── [id].ts            ← GET, DELETE /api/rules/:id
│   ├── stats/
│   │   └── [clientKey].ts     ← GET /api/stats/:clientKey
│   └── mock/
│       └── [...path].ts       ← GET, POST /api/mock/*
├── lib/
│   ├── redis.ts               ← Upstash client + sliding-window logic
│   ├── db.ts                  ← Postgres client + rule queries
│   ├── matcher.ts             ← Route pattern matching
│   └── types.ts               ← Shared TypeScript types
├── scripts/
│   └── migrate.ts             ← One-time DB migration
├── vercel.json
├── tsconfig.json
├── package.json
└── README.md
```

---

## Future work

- Authentication on the management API (JWT / API key)
- Rate-limit bursting (temporary spikes above the steady-state limit)
- Admin dashboard UI
- Webhook notifications when a client hits the limit
- Multi-region Redis replication

---

## License

MIT
