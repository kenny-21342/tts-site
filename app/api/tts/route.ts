import { MAX_INPUT_CHARS, SynthesisError, synthesize } from '@/lib/qwen-tts';
import { DEFAULT_VOICE, isKnownVoice } from '@/lib/voices';

/**
 * POST /api/tts — synthesise one utterance.
 *
 * The API key stays on this side. The client only ever learns the resulting
 * audio URL, which is scoped to that one clip and expires on its own.
 */

type Payload = { text?: unknown; voice?: unknown };

function bad(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
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

  try {
    const { audioUrl } = await synthesize(text, voice);
    return Response.json({ audioUrl, voice });
  } catch (error) {
    if (error instanceof SynthesisError) return bad(error.message, error.status);
    console.error('[api/tts] unexpected failure', error);
    return bad('Synthesis failed.', 500);
  }
}
