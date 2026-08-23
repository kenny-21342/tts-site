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
