import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, RateLimiter } from '../lib/rate-limit.ts';

const config = { charBudget: 1000, requestBudget: 5, windowMs: 60_000 };

test('spends the character budget, not the request count', () => {
  const limiter = new RateLimiter(config);
  const first = limiter.check('a', 600, 0);
  assert.equal(first.allowed, true);
  assert.equal(first.allowed && first.remainingChars, 400);

  // Under the request budget, but over the characters.
  const second = limiter.check('a', 500, 0);
  assert.equal(second.allowed, false);
  assert.equal(second.allowed === false && second.reason, 'chars');
});

test('a refused request does not consume budget', () => {
  const limiter = new RateLimiter(config);
  limiter.check('a', 900, 0);
  limiter.check('a', 500, 0); // refused
  const allowed = limiter.check('a', 100, 0);
  assert.equal(allowed.allowed, true, 'the refusal should not have eaten the remaining 100');
});

test('many tiny requests still hit a ceiling', () => {
  const limiter = new RateLimiter(config);
  for (let i = 0; i < 5; i++) assert.equal(limiter.check('a', 1, 0).allowed, true);
  const sixth = limiter.check('a', 1, 0);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.allowed === false && sixth.reason, 'requests');
});

test('clients are independent', () => {
  const limiter = new RateLimiter(config);
  limiter.check('a', 1000, 0);
  assert.equal(limiter.check('b', 1000, 0).allowed, true);
});

test('the budget returns when the window rolls over', () => {
  const limiter = new RateLimiter(config);
  limiter.check('a', 1000, 0);
  assert.equal(limiter.check('a', 1, 30_000).allowed, false);
  assert.equal(limiter.check('a', 1000, 60_001).allowed, true);
});

test('a refusal says how long to wait', () => {
  const limiter = new RateLimiter(config);
  limiter.check('a', 1000, 0);
  const refused = limiter.check('a', 1, 20_000);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.retryAfterSeconds, 40);
});

test('reads the leftmost forwarded address', () => {
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })), '203.0.113.7');
  assert.equal(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
});

test('an unattributable caller is null, so the route can fail closed', () => {
  assert.equal(clientIp(new Headers()), null);
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '  ' })), null);
});
