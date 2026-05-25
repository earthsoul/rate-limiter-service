import assert from 'node:assert/strict';
import { buildKey, getRedis } from '../../lib/redis.js';

// --- buildKey() --------------------------------------------------------------
assert.equal(buildKey('ip:1.2.3.4', '/api/v1/*'), 'rl:ip:1.2.3.4:/api/v1/*');
assert.equal(buildKey('api_key:abc', '/users'), 'rl:api_key:abc:/users');
assert.equal(buildKey('user_id:42', '/api/**'), 'rl:user_id:42:/api/**');
console.log('buildKey OK');

// --- getRedis() throws clearly when env vars are missing ---------------------
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
assert.throws(() => getRedis(), /UPSTASH_REDIS_REST_URL/, 'should mention which env var is missing');
console.log('getRedis throws cleanly without env vars OK');

// --- getRedis() returns the SAME instance on repeated calls ------------------
// (Fake credentials are fine: @upstash/redis only validates on the first real
//  command, so new Redis({...}) here is just storing config.)
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
const r1 = getRedis();
const r2 = getRedis();
assert.equal(r1, r2, 'second call should return the cached instance, not a new one');
console.log('getRedis is a singleton OK');

console.log('\nAll redis-setup assertions passed.');
