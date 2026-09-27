import { MAX_TOTAL_CHARS } from '@/lib/qwen-tts';
import { clientIp, createRateLimitStore } from '@/lib/rate-limit';
import { RewriteError, rewriteForShanghai } from '@/lib/shanghai-rewrite';

export const maxDuration = 120;

const limiter = createRateLimitStore(process.env, {
  charBudget: 20_000,
  requestBudget: 30,
  windowMs: 60 * 60 * 1000,
}, 'rewrite:rl:');

function bad(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return bad('Requests from other sites are not accepted.', 403);
      }
    } catch {
      return bad('Requests from other sites are not accepted.', 403);
    }
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return bad('Expected a JSON body.', 400);
  }
  const text = payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string'
    ? payload.text.trim()
    : '';
  if (!text) return bad('Enter some text to rewrite.', 400);
  if (text.length > MAX_TOTAL_CHARS) {
    return bad(`Text must be ${MAX_TOTAL_CHARS} characters or fewer.`, 400);
  }

  if (!(process.env.AI_BASE_URL && process.env.AI_API_KEY) &&
      !process.env.OPENROUTER_API_KEY && !process.env.OPENCODE_ZEN_API_KEY) {
    return bad('The server has no rewrite model API configured.', 503);
  }

  const ip = clientIp(request.headers);
  if (!ip) return bad('Could not identify the caller.', 400);
  const limit = await limiter.consume(ip, text.length);
  if (!limit.allowed) {
    return Response.json(
      { error: 'You have used this hour\'s rewrite allowance. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const rewritten = await rewriteForShanghai(text, MAX_TOTAL_CHARS);
    return Response.json({ rewritten });
  } catch (error) {
    if (error instanceof RewriteError) return bad(error.message, error.status);
    console.error('[api/rewrite] unexpected failure', error);
    return bad('Rewrite failed.', 500);
  }
}
