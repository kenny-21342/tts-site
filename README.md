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

## Long text

Anything past `SYNTHESIS_CHUNK_CHARS` (200) is split, synthesised as separate
requests, and joined back into one WAV before it plays. The textarea accepts up
to 4000 characters — twenty parts, so one click can never fire an unbounded
number of billed requests.

**Why 200 and not the 500 the API allows.** Latency is super-linear in input
length and noisy. Measured against the Beijing endpoint from Shanghai:

| chars | 50 | 100 | 150 | 200 | 300 | 440 |
|-------|-----|-----|-----|-----|-----|-----|
| time  | 3.5s | 4.3s | 6.2s | 7.6s | 11.7s | 19.8s, then 34.4s |

A 440-character chunk hit the 50s request timeout in real use. Chunking to fill
the cap is what breaks; chunking for the latency is what works.

Cuts are taken at sentence ends where possible, clause commas where not, and
blind only inside a clause longer than a whole chunk — blind cuts are spread
evenly rather than greedily, so a trailing 。 never ends up alone in a chunk of
its own and billed as a synthesis. `lib/chunk.ts`, tested in `tests/`.

The parts are joined by concatenating PCM and writing one header
(`lib/wav.ts`), not by decoding through the Web Audio API — decoding resamples
to the AudioContext rate and would hand back something subtly different from
what was synthesised. Formats are compared across parts rather than assumed;
joining a 16 kHz clip onto a 24 kHz one would play the tail at the wrong speed.

Requests go one at a time, not in parallel: a partial failure is far easier to
report in order ("Part 2 of 7 failed"), and firing twenty at once is a good way
to meet a rate limit.

## Accessibility

The document is `lang="en"` because the interface is English; the Chinese
content inside it is marked where it appears, with `lang="wuu"` — Wu Chinese —
on the Shanghainese, since that is what the voice actually speaks. This started
as a bug: the page declared itself `zh-Hans`, so a screen reader read the whole
English UI in a Mandarin voice.

Errors announce through `role="alert"`; success announces through a visually
hidden `aria-live` region, because otherwise the only signal that anything
happened is an audio player appearing, which a screen reader user has no reason
to go looking for. The speed slider carries an `aria-valuetext` so it reads
"1.25 times normal speed" rather than "1.25". Every control is at least 44px
tall — the phrase chips were 26px. The progress bar honours
`prefers-reduced-motion`.

Verified at a 320px layout width with a clip loaded: no horizontal overflow,
and no control under 44px.

## Limits on the endpoint

`/api/tts` is unauthenticated and every call costs money, so the budget is
counted in **characters**, not requests — a hundred one-word calls cost less
than one long one, and only characters reflect that. A request floor sits under
it so tiny calls still hit a ceiling. Defaults are 20,000 characters and 120
requests per IP per hour, overridable via `TTS_CHAR_BUDGET`,
`TTS_REQUEST_BUDGET` and `TTS_WINDOW_MS`.

A refused request costs nothing: the limiter runs after validation and before
synthesis, and a refusal does not consume budget.

A caller whose address cannot be established is **refused**, not exempted —
an unattributable caller cannot be rate limited at all.

Cross-origin POSTs are rejected. That is not a security boundary (Origin is
trivially forged outside a browser, and the rate limit is what actually holds)
but it stops someone embedding this synthesise button in their own page and
billing us for their traffic.

**The store is in-process**, so on serverless the effective limit is the budget
times the number of warm instances. Deploying wants a shared store — Upstash or
Vercel KV — behind the same `check` interface. That, plus a spend alert in the
Aliyun console, is what still stands between this and a public URL.

## Deployment

Not deployed. Vercel Deployment Protection cannot keep this private on a Hobby
plan: every project gets a public production `.vercel.app` alias, a new
project's first deployment is always production, and the API rejects
`ssoProtection: all` with *"Vercel Authentication is not available on your plan
for production deployments"*. Since `/api/tts` is unauthenticated and every call
costs money, a public URL needs the rate limit from the P2 hardening task first.

Run it locally until then.
