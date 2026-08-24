/**
 * Minimal client for Qwen3-TTS on Alibaba Cloud Model Studio (DashScope).
 *
 * The API answers with a URL to the synthesised audio rather than the bytes,
 * and that shapes the whole design: the browser fetches the audio directly
 * from Alibaba, so a multi-minute clip never passes through a serverless
 * function. Piping it through would hit the ~4.5 MB response ceiling on
 * Vercel; handing back a URL cannot.
 *
 * The trade is that the URL expires after roughly 24 hours, so it is a
 * playback handle, not storage. Anything worth keeping has to be copied into
 * a bucket — see the caching note in README.md.
 */

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const GENERATION_PATH = '/services/aigc/multimodal-generation/generation';

/**
 * Well inside Vercel's 60s function ceiling, so a slow synthesis surfaces as
 * our error rather than the platform's opaque timeout.
 */
const REQUEST_TIMEOUT_MS = 50_000;

export const MAX_INPUT_CHARS = 500;

export type SynthesisResult = { audioUrl: string };

export class SynthesisError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SynthesisError';
    this.status = status;
  }
}

/** Shape of the bits of the DashScope response we rely on. */
type DashScopeResponse = {
  output?: { audio?: { url?: string } };
  code?: string;
  message?: string;
};

export function isConfigured(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

export async function synthesize(text: string, voice: string): Promise<SynthesisResult> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new SynthesisError('The server has no DASHSCOPE_API_KEY configured.', 503);
  }

  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? DEFAULT_BASE_URL;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${GENERATION_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DASHSCOPE_TTS_MODEL ?? 'qwen3-tts-flash',
        input: { text, voice, language_type: 'Chinese' },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new SynthesisError(
      timedOut ? 'Synthesis timed out. Try shorter text.' : 'Could not reach the speech service.',
      504,
    );
  }

  // Read the body once, as text, so a non-JSON error page (a gateway or a
  // captive proxy) does not throw a parse error on top of the real failure.
  const raw = await response.text();
  let body: DashScopeResponse = {};
  try {
    body = JSON.parse(raw) as DashScopeResponse;
  } catch {
    // Leave `body` empty; handled below.
  }

  if (!response.ok) {
    // `body.message` is the provider's own description. It is safe to surface:
    // it describes the request, never the credential.
    console.error('[qwen-tts] %d %s %s', response.status, body.code ?? '', body.message ?? raw.slice(0, 300));
    throw new SynthesisError(
      body.message ?? `The speech service returned ${response.status}.`,
      response.status === 429 ? 429 : 502,
    );
  }

  const audioUrl = body.output?.audio?.url;
  if (!audioUrl) {
    console.error('[qwen-tts] 200 with no audio url: %s', raw.slice(0, 300));
    throw new SynthesisError('The speech service returned no audio.', 502);
  }

  // DashScope hands back an `http://` OSS link. The same object serves fine
  // over TLS, and on an https-hosted page the browser blocks the plain-http
  // one as mixed content — silently, with no error the page can catch. Upgrade
  // it here so the failure never reaches production.
  return { audioUrl: audioUrl.replace(/^http:\/\//, 'https://') };
}
