/**
 * The voice catalogue.
 *
 * With Qwen3-TTS the dialect is not a separate parameter — it is carried by the
 * voice itself. There is no `dialect: 'Shanghainese'` field to set; you pick
 * `Jada` and that *is* how you ask for Shanghainese.
 *
 * That has a consequence worth knowing before building a voice picker: exactly
 * one Shanghainese voice exists. Everything else here is for A/B comparison
 * while evaluating the engine, not for shipping as user-facing choice.
 *
 * The canonical list lives at
 * https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list — re-check it
 * before relying on any id below.
 */

export type Voice = {
  /** The exact string sent as `input.voice`. */
  id: string;
  /** Name as Alibaba labels it. */
  native: string;
  /** What it actually speaks. */
  variety: string;
};

export const VOICES: readonly Voice[] = [
  { id: 'Jada', native: '上海-阿珍', variety: 'Shanghainese' },
  { id: 'Rocky', native: '粤语-阿强', variety: 'Cantonese' },
  { id: 'Sunny', native: '四川-晴儿', variety: 'Sichuanese' },
  { id: 'Dylan', native: '北京-晓东', variety: 'Beijing Mandarin' },
  { id: 'Cherry', native: 'Cherry', variety: 'Standard Mandarin' },
] as const;

export const DEFAULT_VOICE = 'Jada';

export function isKnownVoice(value: unknown): value is string {
  return typeof value === 'string' && VOICES.some((voice) => voice.id === value);
}
