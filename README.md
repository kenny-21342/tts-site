# Shanghainese TTS

Type Chinese text, hear it in Shanghainese. A prototype of the P1 MVP —
text in, audio out, played inline.

## Why Qwen3-TTS

Shanghainese eliminates almost every TTS provider. Of the three that remain,
Qwen3-TTS is the only hosted one with independently published Wu-dialect
quality figures, and it holds up best on hard inputs — which is what a public
text box produces. Full reasoning, benchmark numbers and the alternatives:
https://claude.ai/code/artifact/85c31eae-f0bb-4462-b2e7-992f995ac732

## Running it

```bash
cp .env.example .env.local     # then paste your DashScope key into it
npm run dev
```

Without a key the UI loads and the API answers `503` with a clear message,
rather than failing obscurely.

## How the dialect is selected

There is no dialect parameter. With Qwen3-TTS the dialect is carried by the
voice, so asking for Shanghainese means sending `voice: "Jada"` (上海-阿珍).

**Exactly one Shanghainese voice exists.** That is a real constraint on the
planned voice picker: speed and format are adjustable, but for Shanghainese
the voice itself is not a choice. The other voices in `lib/voices.ts` are
there for A/B comparison while evaluating the engine, not to ship.

## What to listen for

The preset phrases in the UI are chosen to trigger **tone sandhi** —
Shanghainese changes a syllable's tone depending on the word it belongs to,
so getting it wrong yields the wrong word, not merely an accent. Published
work finds existing systems handle left-dominant sandhi poorly. Single
characters sound fine everywhere; the multi-syllable phrases are the test.

If the presets sound wrong, the fix is a text-normalisation step with word
segmentation before synthesis. That work sits on this side of the API
whatever engine is used.

## Why the audio is a URL and not bytes

DashScope answers with a link to the clip rather than the audio itself, and
this app passes that link straight to the browser. So the audio never travels
through a serverless function, which matters: Vercel caps a function response
at roughly 4.5 MB, and a few minutes of speech exceeds that. Proxying the
bytes would have imposed a length limit that handing over a URL does not.

The trade-off is that the link expires after about 24 hours. It is a playback
handle, not storage.

## Not done yet

- **Caching.** Every press costs money, including for text synthesised a
  moment ago. Keying a bucket on a hash of `(text, voice)` makes repeats free
  and gives the audio a permanent home instead of a 24-hour link. The R2
  driver in `smart-edu/lib/storage` does this already and lifts across.
- **Rate limiting.** The endpoint is unauthenticated and spends money. The
  500-character cap bounds a single request but not the number of requests.
  An in-memory limiter is useless on serverless — each invocation gets a
  fresh process — so it needs a durable store, as `smart-edu/lib/rate-limit.ts`
  found the hard way.
- **Long text.** No chunking or stitching yet, hence the 500-character cap.
- **Downloads, speed and pitch controls.** P1 items, not started.

## Speed, pitch, and formats

Qwen3-TTS takes `text`, `voice` and `language_type` — and that is all. There is
no speed parameter, no pitch parameter, and no format or sample-rate option;
the API always answers with a 24 kHz mono WAV.

So the speed slider is applied to the `<audio>` element on playback, not
requested from the API. That makes it instant and free, it re-rates a clip you
already paid for, and it cannot cost us the Shanghainese voice. `preservesPitch`
stays on, because a Jada clip pitched up by a rate change is no longer the thing
being evaluated.

**Pitch is not available at all**, and MP3 would mean encoding in the browser.
Neither is a gap in this page — they are the engine's shape.

The one escape hatch is `qwen3-tts-instruct-flash`, which takes a
natural-language `instructions` string ("语速较快，带有明显的上扬语调") to steer
rate and prosody. It is a different model, it costs a synthesis per change, and
the docs do not say whether it carries the dialect voices. Worth an experiment
before relying on it.

## Deployment

Not deployed. Vercel Deployment Protection cannot keep this private on a Hobby
plan: every project gets a public production `.vercel.app` alias, a new
project's first deployment is always production, and the API rejects
`ssoProtection: all` with *"Vercel Authentication is not available on your plan
for production deployments"*. Since `/api/tts` is unauthenticated and every call
costs money, a public URL needs the rate limit from the P2 hardening task first.

Run it locally until then.
