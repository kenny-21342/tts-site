'use client';

import { useRef, useState } from 'react';
import { DEFAULT_VOICE, VOICES } from '@/lib/voices';
import { MAX_INPUT_CHARS } from '@/lib/qwen-tts';

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
  const audioRef = useRef<HTMLAudioElement>(null);

  const over = text.length > MAX_INPUT_CHARS;
  const selected = VOICES.find((v) => v.id === voice);

  async function speak() {
    setLoading(true);
    setError(null);
    setAudioUrl(null);
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      const body = (await response.json()) as { audioUrl?: string; error?: string };
      if (!response.ok || !body.audioUrl) {
        setError(body.error ?? 'Synthesis failed.');
        return;
      }
      setAudioUrl(body.audioUrl);
      // The <audio> element is keyed on the URL, so it remounts; play once the
      // browser has had a tick to attach the new source.
      requestAnimationFrame(() => void audioRef.current?.play().catch(() => {}));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
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
            {text.length}/{MAX_INPUT_CHARS}
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

      <button
        type="button"
        onClick={speak}
        disabled={loading || over || text.trim().length === 0}
        className="rounded-lg bg-emerald-700 px-5 py-3 font-medium text-white transition hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-600 dark:hover:bg-emerald-500"
      >
        {loading ? 'Synthesising…' : 'Speak'}
      </button>

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
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Served directly from Alibaba; the link expires in about 24 hours.
          </p>
        </section>
      )}
    </main>
  );
}
