'use client';

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_VOICE, VOICES } from '@/lib/voices';
import { MAX_TOTAL_CHARS, SYNTHESIS_CHUNK_CHARS } from '@/lib/qwen-tts';
import { splitForSynthesis } from '@/lib/chunk';
import { concatWav, WavError } from '@/lib/wav';

/**
 * Phrases chosen to exercise tone sandhi, which is the failure mode worth
 * listening for: Shanghainese changes a syllable's tone according to the word
 * it sits in, and getting it wrong produces the wrong word rather than merely
 * an accent. Single characters will sound fine on almost any engine; these
 * will not.
 */
const SANDHI_PROBES = [
  '侬好',
  '谢谢侬',
  '阿拉是上海人',
  '侬吃过饭了伐',
  '今朝天气老好额',
];

export default function Home() {
  const [text, setText] = useState('阿拉是上海人');
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [joinedUrl, setJoinedUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Playback rate is applied to the element rather than requested from the
  // API. Qwen3-TTS has no speed parameter — only the `-instruct` variant takes
  // a natural-language hint, and that is a different model whose support for
  // the dialect voices is undocumented. Doing it here is free, instant, and
  // cannot cost us Jada.
  useEffect(() => () => { if (joinedUrl) URL.revokeObjectURL(joinedUrl); }, [joinedUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
    // Keep the formants where they are: a Shanghainese voice pitched up by a
    // playback-rate change is no longer the thing being evaluated.
    audio.preservesPitch = true;
  }, [speed, audioUrl]);

  const over = text.length > MAX_TOTAL_CHARS;
  const chunkCount = splitForSynthesis(text, SYNTHESIS_CHUNK_CHARS).length;
  const selected = VOICES.find((v) => v.id === voice);

  /**
   * Synthesise, in as many requests as the text needs.
   *
   * The split happens here rather than server-side so that progress is real:
   * each chunk is a round trip the user can watch complete, instead of one
   * opaque request that either returns after a minute or times out. It also
   * keeps every individual request inside the function timeout no matter how
   * long the input is.
   *
   * The clips are then joined into one WAV, so what plays and what downloads
   * is a single file rather than a playlist the user has to sit through in
   * order.
   */
  async function speak() {
    const chunks = splitForSynthesis(text, SYNTHESIS_CHUNK_CHARS);
    if (chunks.length === 0) return;

    setLoading(true);
    setError(null);
    setAudioUrl(null);
    setJoinedUrl(null);
    setProgress({ done: 0, total: chunks.length });

    try {
      const clips: ArrayBuffer[] = [];

      // Sequential, not parallel: the chunks of one utterance are cheap to
      // fire all at once and expensive to get rate-limited on, and a partial
      // failure halfway through is far easier to report in order.
      for (const [index, chunk] of chunks.entries()) {
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: chunk, voice }),
        });
        const body = (await response.json()) as { audioUrl?: string; error?: string };
        if (!response.ok || !body.audioUrl) {
          setError(
            chunks.length === 1
              ? body.error ?? 'Synthesis failed.'
              : `Part ${index + 1} of ${chunks.length} failed: ${body.error ?? 'synthesis failed'}`,
          );
          return;
        }

        const audio = await fetch(body.audioUrl);
        if (!audio.ok) {
          setError(`Could not fetch the audio for part ${index + 1}.`);
          return;
        }
        clips.push(await audio.arrayBuffer());
        setProgress({ done: index + 1, total: chunks.length });
      }

      const { blob } = concatWav(clips);
      setJoinedUrl(URL.createObjectURL(blob));
      setAudioUrl(URL.createObjectURL(blob));
      // The <audio> element is keyed on the URL, so it remounts; play once the
      // browser has had a tick to attach the new source.
      requestAnimationFrame(() => void audioRef.current?.play().catch(() => {}));
    } catch (caught) {
      setError(
        caught instanceof WavError
          ? `The parts could not be joined: ${caught.message}`
          : 'Could not reach the server.',
      );
    } finally {
      setLoading(false);
    }
  }

  /** Save the joined clip. The blob is already in hand, so this cannot fail. */
  function download() {
    if (!joinedUrl) return;
    setDownloading(true);
    try {
      const anchor = document.createElement('a');
      anchor.href = joinedUrl;
      anchor.download = `${voice}-${text.slice(0, 12)}.wav`;
      anchor.click();
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-5 py-12 sm:py-16">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
          Qwen3-TTS · prototype
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Shanghainese text to speech
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Type Chinese text, pick a voice, hear it spoken.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <label htmlFor="text" className="text-sm font-medium">
          Text
        </label>
        <textarea
          id="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-neutral-300 bg-white px-3.5 py-3 text-lg leading-relaxed outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-neutral-700 dark:bg-neutral-900"
          placeholder="侬好"
        />
        {over && (
          <p className="text-xs text-red-600 dark:text-red-400">
            Too long by {text.length - MAX_TOTAL_CHARS} characters. The cap exists because each part
            is a separate billed request.
          </p>
        )}
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <div className="flex flex-wrap gap-1.5">
            {SANDHI_PROBES.map((phrase) => (
              <button
                key={phrase}
                type="button"
                onClick={() => setText(phrase)}
                className="rounded-full border border-neutral-300 px-2.5 py-1 text-neutral-600 transition hover:border-emerald-600 hover:text-emerald-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
              >
                {phrase}
              </button>
            ))}
          </div>
          <span
            className={`shrink-0 font-mono tabular-nums ${
              over ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'
            }`}
          >
            {text.length}/{MAX_TOTAL_CHARS}
            {chunkCount > 1 && ` · ${chunkCount} parts`}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <label htmlFor="voice" className="text-sm font-medium">
          Voice
        </label>
        <select
          id="voice"
          value={voice}
          onChange={(event) => setVoice(event.target.value)}
          className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-neutral-700 dark:bg-neutral-900"
        >
          {VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.native} — {v.variety}
            </option>
          ))}
        </select>
        {selected?.variety !== 'Shanghainese' && (
          <p className="text-xs text-amber-700 dark:text-amber-500">
            Not Shanghainese — {selected?.variety}. Useful for comparison only.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <label htmlFor="speed" className="text-sm font-medium">
            Playback speed
          </label>
          <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
            {speed.toFixed(2)}×
          </span>
        </div>
        <input
          id="speed"
          type="range"
          min={0.5}
          max={1.5}
          step={0.05}
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          className="w-full accent-emerald-700 dark:accent-emerald-500"
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Applied on playback, so it changes the current clip instantly and costs nothing.
          The engine has no pitch control — that is not a gap in this page.
        </p>
      </section>

      <button
        type="button"
        onClick={speak}
        disabled={loading || over || text.trim().length === 0}
        className="rounded-lg bg-emerald-700 px-5 py-3 font-medium text-white transition hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-600 dark:hover:bg-emerald-500"
      >
        {loading
          ? progress && progress.total > 1
            ? `Synthesising ${progress.done + 1} of ${progress.total}…`
            : 'Synthesising…'
          : 'Speak'}
      </button>

      {/* Only shown for text that actually had to be split — a progress bar
          for a single three-second clip is noise. */}
      {loading && progress && progress.total > 1 && (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label="Synthesis progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          >
            <div
              className="h-full rounded-full bg-emerald-700 transition-[width] duration-300 dark:bg-emerald-500"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {progress.done} of {progress.total} parts done — they are joined into one clip at the end.
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {audioUrl && (
        <section className="flex flex-col gap-2">
          {/* Keyed so a new clip replaces the element rather than reusing a
              stale buffered source. */}
          <audio key={audioUrl} ref={audioRef} controls src={audioUrl} className="w-full" />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {chunkCount > 1 ? `Joined from ${chunkCount} parts.` : 'Synthesised just now.'}
            </p>
            <button
              type="button"
              onClick={download}
              disabled={downloading}
              className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium transition hover:border-emerald-600 hover:text-emerald-700 disabled:opacity-40 dark:border-neutral-700 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
            >
              {downloading ? 'Saving…' : 'Download WAV'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
