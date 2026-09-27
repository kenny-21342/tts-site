/** One whole-text pass before the browser splits the result for TTS. */
const OPENCODE_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_CUSTOM_MODEL = 'gpt-5.5';
const DEFAULT_OPENCODE_MODEL = 'mimo-v2.6-flash-free';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
const TIMEOUT_MS = 90_000;

type Completion = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

export class RewriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RewriteError';
    this.status = status;
  }
}

export async function rewriteForShanghai(
  text: string,
  maxChars: number,
  options: { apiKey?: string; baseUrl?: string; model?: string; provider?: 'custom' | 'opencode' | 'openrouter'; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const provider = options.provider ?? (process.env.AI_BASE_URL && process.env.AI_API_KEY
    ? 'custom'
    : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'opencode');
  const apiKey = options.apiKey ?? (provider === 'custom'
    ? process.env.AI_API_KEY
    : provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OPENCODE_ZEN_API_KEY);
  if (!apiKey) {
    const keyName = provider === 'custom' ? 'AI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENCODE_ZEN_API_KEY';
    throw new RewriteError(`The server has no ${keyName} configured.`, 503);
  }
  const customBase = (options.baseUrl ?? process.env.AI_BASE_URL)?.replace(/\/+$/, '');
  if (provider === 'custom' && !customBase) {
    throw new RewriteError('The server has no AI_BASE_URL configured.', 503);
  }
  const endpoint = provider === 'custom'
    ? customBase!.endsWith('/chat/completions') ? customBase! : `${customBase}/chat/completions`
    : provider === 'openrouter' ? OPENROUTER_ENDPOINT : OPENCODE_ENDPOINT;
  const model = options.model ?? (provider === 'custom'
    ? process.env.AI_MODEL ?? DEFAULT_CUSTOM_MODEL
    : provider === 'openrouter' ? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL
      : process.env.OPENCODE_ZEN_MODEL ?? DEFAULT_OPENCODE_MODEL);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: [
              'You prepare Chinese text for a Shanghainese (上海话) text-to-speech voice.',
              'Rewrite Mandarin-style wording into natural spoken Shanghainese wording using Chinese characters.',
              'Preserve the meaning, names, numbers, quoted text, and sentence order.',
              'Use local vocabulary only where it fits the context; for example 学堂 can be a local way to say 学校, but do not blindly replace proper names.',
              'Do not translate into Mandarin, romanize, explain, add facts, or add labels.',
              'If unsure about a phrase, leave it unchanged. Return only the rewritten text.',
            ].join(' '),
          },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new RewriteError(
      timedOut ? 'The rewrite timed out. Try shorter text.' : 'Could not reach the rewrite service.',
      504,
    );
  }

  if (!response.ok) {
    let upstreamMessage = '';
    try {
      const body = (await response.json()) as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof body.error === 'object' ? body.error?.message : body.error;
      upstreamMessage = typeof message === 'string' ? message : typeof body.message === 'string' ? body.message : '';
    } catch {
      // The status is enough to return a useful generic error.
    }
    console.error('[shanghai-rewrite] %s upstream status %d', provider, response.status);
    if (provider === 'opencode' && response.status === 403 && upstreamMessage.includes('free tier can only be used from within OpenCode')) {
      throw new RewriteError('OpenCode free models cannot be called by this site. Configure OPENROUTER_API_KEY for a free API model.', 503);
    }
    throw new RewriteError(
      response.status === 429
        ? 'The rewrite service is busy. Try again shortly.'
        : response.status === 401 || response.status === 403
          ? 'The rewrite account cannot access this model. Check its API key and model.'
          : 'The rewrite service failed.',
      response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 403 : 502,
    );
  }

  let body: Completion;
  try {
    body = (await response.json()) as Completion;
  } catch {
    throw new RewriteError('The rewrite service returned an invalid response.', 502);
  }

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new RewriteError('The rewrite service returned no text.', 502);
  }

  const rewritten = content.trim();
  if (rewritten.length > maxChars) {
    throw new RewriteError(`The rewrite exceeds the ${maxChars}-character limit. Try shorter text.`, 502);
  }
  return rewritten;
}
