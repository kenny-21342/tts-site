/**
 * A per-IP rate limiter for an endpoint that spends money.
 *
 * `/api/tts` bills per character against a real account, so the thing being
 * protected is not the server's CPU but the bill. That shapes two decisions:
 * the budget is counted in *characters*, not requests — a hundred one-word
 * calls cost less than one long one, and only the character count reflects
 * that — and the limiter fails closed on anything it cannot attribute.
 *
 * The store is in-process. On a single long-lived server that is exactly
 * right; on serverless it is per-instance, so the effective limit is the
 * budget times the number of warm instances. That is a real weakness and the
 * reason a deployed version wants a shared store (Upstash, Vercel KV) rather
 * than this. It is written to be swapped: `check` is the whole interface.
 */

export type RateLimitConfig = {
  /** Characters allowed per window, per client. */
  charBudget: number;
  /** Requests allowed per window, per client — a floor under tiny requests. */
  requestBudget: number;
  windowMs: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Overridable by environment so the budget can be tuned, or dropped to
 * something tiny to exercise the refusal path, without a code change.
 */
export const DEFAULT_LIMIT: RateLimitConfig = {
  // Roughly forty full-length synthesis requests an hour: generous for a
  // person evaluating voices, useless to someone scraping free TTS.
  charBudget: envInt('TTS_CHAR_BUDGET', 20_000),
  requestBudget: envInt('TTS_REQUEST_BUDGET', 120),
  windowMs: envInt('TTS_WINDOW_MS', 60 * 60 * 1000),
};

type Bucket = { chars: number; requests: number; resetAt: number };

export type RateLimitResult =
  | { allowed: true; remainingChars: number; resetAt: number }
  | { allowed: false; reason: 'chars' | 'requests'; retryAfterSeconds: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: RateLimitConfig;

  // Written as a plain assignment rather than a parameter property: Node's
  // type-stripping runs the tests directly and does not support those.
  constructor(config: RateLimitConfig = DEFAULT_LIMIT) {
    this.config = config;
  }

  /**
   * Record `chars` against `key` and say whether it may proceed.
   *
   * @param now injectable so the tests do not have to sleep through a window.
   */
  check(key: string, chars: number, now: number = Date.now()): RateLimitResult {
    this.sweep(now);

    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { chars: 0, requests: 0, resetAt: now + this.config.windowMs };

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    if (bucket.requests + 1 > this.config.requestBudget) {
      this.buckets.set(key, bucket);
      return { allowed: false, reason: 'requests', retryAfterSeconds };
    }
    if (bucket.chars + chars > this.config.charBudget) {
      this.buckets.set(key, bucket);
      return { allowed: false, reason: 'chars', retryAfterSeconds };
    }

    bucket.chars += chars;
    bucket.requests += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remainingChars: this.config.charBudget - bucket.chars,
      resetAt: bucket.resetAt,
    };
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** The `RateLimitStore` face of the in-process limiter. */
  async consume(key: string, chars: number, now: number = Date.now()): Promise<RateLimitResult> {
    return this.check(key, chars, now);
  }

  /** Test seam. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * The caller's address, or null when it cannot be established.
 *
 * Null must fail closed. `x-forwarded-for` is client-controlled unless a proxy
 * you trust overwrites it, so the leftmost entry is only meaningful behind
 * such a proxy — which is why the header is read, but its absence is never
 * treated as "allow".
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

/* ------------------------------------------------------------------------ *
 * Shared store
 *
 * `RateLimiter` above keeps its buckets in one process, which on serverless
 * means the effective budget is the configured one times however many
 * instances happen to be warm. That is fine locally and wrong in production,
 * where this endpoint is unauthenticated and every character costs money.
 *
 * The seam is `consume`. A store either counts in memory or counts in Redis;
 * the route does not know which it got.
 * ------------------------------------------------------------------------ */

export interface RateLimitStore {
  consume(key: string, chars: number, now?: number): Promise<RateLimitResult>;
}

/**
 * Counts a whole window in one atomic server-side step.
 *
 * Read-then-write over the network is not good enough here: two concurrent
 * requests would both read the old total and both be allowed, which is
 * exactly the case a shared store exists to close. Everything happens inside
 * one EVAL so there is no window between the check and the increment.
 *
 * Returns {allowed, reason, ttlMs, remainingChars}, where reason is 1 for the
 * request budget and 2 for the character budget.
 */
const CONSUME_SCRIPT = `
local charBudget = tonumber(ARGV[1])
local reqBudget = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local chars = tonumber(ARGV[4])
local key = KEYS[1]

local ttl = redis.call('PTTL', key)
if ttl < 0 then
  redis.call('DEL', key)
  redis.call('HSET', key, 'c', 0, 'r', 0)
  redis.call('PEXPIRE', key, windowMs)
  ttl = windowMs
end

local c = tonumber(redis.call('HGET', key, 'c') or '0')
local r = tonumber(redis.call('HGET', key, 'r') or '0')

if r + 1 > reqBudget then return {0, 1, ttl, 0} end
if c + chars > charBudget then return {0, 2, ttl, 0} end

redis.call('HINCRBY', key, 'c', chars)
redis.call('HINCRBY', key, 'r', 1)
return {1, 0, ttl, charBudget - (c + chars)}
`;

export type UpstashStoreOptions = {
  url: string;
  token: string;
  config?: RateLimitConfig;
  /** Injectable so the tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Used when Redis is unreachable. Defaults to a fresh in-process limiter. */
  fallback?: RateLimiter;
  /** Namespace, so several deployments can share one database safely. */
  prefix?: string;
};

export class UpstashStore implements RateLimitStore {
  private readonly url: string;
  private readonly token: string;
  private readonly config: RateLimitConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: RateLimiter;
  private readonly prefix: string;

  constructor(options: UpstashStoreOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.config = options.config ?? DEFAULT_LIMIT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallback ?? new RateLimiter(this.config);
    this.prefix = options.prefix ?? 'tts:rl:';
  }

  async consume(key: string, chars: number, now: number = Date.now()): Promise<RateLimitResult> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([
          'EVAL',
          CONSUME_SCRIPT,
          '1',
          this.prefix + key,
          String(this.config.charBudget),
          String(this.config.requestBudget),
          String(this.config.windowMs),
          String(chars),
        ]),
      });
      if (!response.ok) throw new Error(`Upstash responded ${response.status}`);

      const body = (await response.json()) as { result?: unknown; error?: string };
      if (body.error) throw new Error(body.error);
      if (!Array.isArray(body.result) || body.result.length < 4) {
        throw new Error('Upstash returned an unexpected shape');
      }

      const [allowed, reason, ttlMs, remaining] = body.result.map(Number);
      const retryAfterSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (allowed === 1) {
        return { allowed: true, remainingChars: remaining, resetAt: now + ttlMs };
      }
      return {
        allowed: false,
        reason: reason === 1 ? 'requests' : 'chars',
        retryAfterSeconds,
      };
    } catch (error) {
      // Degrade rather than fail open OR fail closed. Refusing everything
      // would take the whole site down with the cache; allowing everything
      // would leave the money unguarded. Per-instance counting is the weaker
      // of the two guarantees, not the absence of one.
      console.error('[rate-limit] shared store unavailable, counting per-instance:', error);
      return this.fallback.check(key, chars, now);
    }
  }
}

/**
 * The limiter the route should use: shared when the deployment has a Redis
 * configured, in-process otherwise. Reading the env here rather than at module
 * scope keeps the choice testable.
 */
export function createRateLimitStore(
  env: Record<string, string | undefined> = process.env,
  config: RateLimitConfig = DEFAULT_LIMIT,
  prefix = 'tts:rl:',
): RateLimitStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashStore({ url, token, config, prefix });
  return new RateLimiter(config);
}
