/**
 * Hits real Upstash Redis with the sliding-window algorithm.
 *
 *   npx tsx --env-file=.env scripts/_smoke/sliding-window.ts
 *
 * Uses a timestamped clientKey so every run gets a fresh window
 * (no need to wait 30s between runs while developing).
 */
import { checkSlidingWindow } from '../../lib/redis.js';

async function main() {
  const params = {
    clientKey: `ip:smoke-${Date.now()}`,
    routePattern: '/api/test',
    limit: 5,
    windowSeconds: 30,
  };

  console.log(`Sliding-window smoke against real Upstash`);
  console.log(`  rule:       ${params.limit} requests per ${params.windowSeconds}s`);
  console.log(`  clientKey:  ${params.clientKey}`);
  console.log(`  expect:     5 ALLOW (remaining 4..0), then 1 DENY with retryAfter ~${params.windowSeconds}s\n`);

  for (let i = 1; i <= 6; i++) {
    const t0 = Date.now();
    const r = await checkSlidingWindow(params);
    const ms = Date.now() - t0;
    const tag = r.allowed ? 'ALLOW' : 'DENY ';
    const retry = r.retryAfter !== undefined ? `retryAfter=${r.retryAfter}s ` : '';
    console.log(
      `  ${i}.  ${tag}  count=${r.count}  remaining=${r.remaining}  ${retry}(${ms}ms round trip)`
    );
  }
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
