import { MAX_INPUT_CHARS, SynthesisError, synthesize } from '@/lib/qwen-tts';
import { DEFAULT_VOICE, isKnownVoice } from '@/lib/voices';
import { clientIp, createRateLimitStore } from '@/lib/rate-limit';

/**
 * POST /api/tts — synthesise one utterance.
 *
 * The API key stays on this side. The client only ever learns the resulting
 * audio URL, which is scoped to that one clip and expires on its own.
 */

/**
 * Module scope, so an in-process limiter's buckets survive between requests on
 * one instance. With UPSTASH_REDIS_REST_URL and _TOKEN set this is instead a
 * shared store and the count holds across every instance -- which is what a
 * public deployment needs, since the budget being protected is a real bill.
 */
const limiter = createRateLimitStore();

type Payload = { text?: unknown; voice?: unknown };

/**
 * Reject requests that did not come from this site's own page.
 *
 * This is not a security boundary — Origin is trivially forged outside a
 * browser — but it is the difference between "someone deliberately abused the
 * endpoint" and "someone embedded our synthesise button in their page and we
 * paid for their traffic". Same-origin requests from our own client send an
 * Origin header on POST; anything from another site is refused.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // curl, server-to-server: the rate limit covers these.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function bad(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!originAllowed(request)) return bad('Requests from other sites are not accepted.', 403);

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return bad('Expected a JSON body.', 400);
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return bad('Enter some text to speak.', 400);

  // A hard cap, not a UI convenience: every character billed is real money,
  // and this endpoint is unauthenticated in the prototype.
  if (text.length > MAX_INPUT_CHARS) {
    return bad(`Text must be ${MAX_INPUT_CHARS} characters or fewer.`, 400);
  }

  // Allowlist rather than pass-through — the voice string reaches a paid
  // upstream, and an unknown value should fail here, not there.
  const voice = isKnownVoice(payload.voice) ? payload.voice : DEFAULT_VOICE;

  // Charged before synthesis, and only once the text is known to be valid, so
  // a malformed request cannot burn someone's budget.
  const ip = clientIp(request.headers);
  if (!ip) {
    // Fail closed: an unattributable caller cannot be rate limited, and this
    // endpoint spends money on every call.
    console.error('[api/tts] refusing a request with no attributable address');
    return bad('Could not identify the caller.', 400);
  }

  const limit = await limiter.consume(ip, text.length);
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          limit.reason === 'chars'
            ? 'You have used this hour\'s synthesis allowance. Try again shortly.'
            : 'Too many requests. Try again shortly.',
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const { audioUrl } = await synthesize(text, voice);
    return Response.json({ audioUrl, voice });
  } catch (error) {
    if (error instanceof SynthesisError) return bad(error.message, error.status);
    console.error('[api/tts] unexpected failure', error);
    return bad('Synthesis failed.', 500);
  }
}
