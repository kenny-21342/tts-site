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
