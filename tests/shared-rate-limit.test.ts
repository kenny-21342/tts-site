import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRateLimitStore,
  RateLimiter,
  UpstashStore,
  type RateLimitConfig,
} from '../lib/rate-limit.ts';

const CONFIG: RateLimitConfig = {
  charBudget: 100,
  requestBudget: 3,
  windowMs: 60_000,
};

/**
 * A stand-in for Upstash that actually runs the budget arithmetic, so these
 * tests exercise the store's request/response handling against realistic
 * answers rather than a fixed stub.
 */
function fakeUpstash(config: RateLimitConfig) {
  const state = { chars: 0, requests: 0 };
  const calls: string[][] = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body)) as string[];
    calls.push(args);
    const chars = Number(args[args.length - 1]);
    const ttl = config.windowMs;
    if (state.requests + 1 > config.requestBudget) {
      return Response.json({ result: [0, 1, ttl, 0] });
    }
    if (state.chars + chars > config.charBudget) {
      return Response.json({ result: [0, 2, ttl, 0] });
    }
    state.chars += chars;
    state.requests += 1;
    return Response.json({
      result: [1, 0, ttl, config.charBudget - state.chars],
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, state };
}

test('a shared store allows a request within budget', async () => {
  const fake = fakeUpstash(CONFIG);
  const store = new UpstashStore({
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: fake.fetchImpl,
  });

  const result = await store.consume('1.2.3.4', 40);
  assert.equal(result.allowed, true);
  assert.equal(result.allowed && result.remainingChars, 60);
});

test('the character budget is enforced across instances', async () => {
  const fake = fakeUpstash(CONFIG);
  const options = {
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: fake.fetchImpl,
  };
  // Two stores standing in for two warm serverless instances. With the old
  // in-process limiter each would have had its own 100-character budget.
  const instanceA = new UpstashStore(options);
  const instanceB = new UpstashStore(options);

  assert.equal((await instanceA.consume('1.2.3.4', 60)).allowed, true);
  const second = await instanceB.consume('1.2.3.4', 60);
  assert.equal(second.allowed, false);
  assert.equal(second.allowed === false && second.reason, 'chars');
});

test('the request budget is enforced separately from characters', async () => {
  const fake = fakeUpstash(CONFIG);
  const store = new UpstashStore({
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: fake.fetchImpl,
  });

  for (let i = 0; i < 3; i++) {
    assert.equal((await store.consume('1.2.3.4', 1)).allowed, true);
  }
  const refused = await store.consume('1.2.3.4', 1);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.reason, 'requests');
  assert.ok(refused.allowed === false && refused.retryAfterSeconds > 0);
});

test('keys are namespaced so deployments can share one database', async () => {
  const fake = fakeUpstash(CONFIG);
  const store = new UpstashStore({
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: fake.fetchImpl,
    prefix: 'tts:staging:',
  });

  await store.consume('1.2.3.4', 1);
  assert.equal(fake.calls[0][3], 'tts:staging:1.2.3.4');
});

test('an unreachable store degrades to per-instance counting, not to open', async () => {
  const failing = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const store = new UpstashStore({
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: failing,
    fallback: new RateLimiter(CONFIG),
  });

  assert.equal((await store.consume('1.2.3.4', 60)).allowed, true);
  // Still counted somewhere: the same caller cannot immediately spend again.
  const second = await store.consume('1.2.3.4', 60);
  assert.equal(second.allowed, false);
});

test('an HTTP error from Upstash is treated as unavailable', async () => {
  const erroring = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const store = new UpstashStore({
    url: 'https://redis.example',
    token: 't',
    config: CONFIG,
    fetchImpl: erroring,
    fallback: new RateLimiter(CONFIG),
  });

  const result = await store.consume('1.2.3.4', 10);
  assert.equal(result.allowed, true); // fell back, did not throw
});

test('the factory picks a shared store only when both env vars are set', () => {
  assert.ok(createRateLimitStore({}, CONFIG) instanceof RateLimiter);
  assert.ok(
    createRateLimitStore({ UPSTASH_REDIS_REST_URL: 'https://r.example' }, CONFIG) instanceof
      RateLimiter,
  );
  assert.ok(
    createRateLimitStore(
      { UPSTASH_REDIS_REST_URL: 'https://r.example', UPSTASH_REDIS_REST_TOKEN: 't' },
      CONFIG,
    ) instanceof UpstashStore,
  );
});

test('the in-process limiter satisfies the same interface', async () => {
  const limiter = new RateLimiter(CONFIG);
  const result = await limiter.consume('1.2.3.4', 10);
  assert.equal(result.allowed, true);
});
