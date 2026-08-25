import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatWav, parseWav, WavError } from '../lib/wav.ts';

/** Build a WAV carrying `frames` samples, optionally with a padding chunk. */
function makeWav({
  frames,
  sampleRate = 24_000,
  channels = 1,
  bitsPerSample = 16,
  extraChunk = false,
}: {
  frames: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  extraChunk?: boolean;
}): ArrayBuffer {
  const bytesPerFrame = (channels * bitsPerSample) / 8;
  const dataBytes = frames * bytesPerFrame;
  // A LIST chunk of odd length, to exercise both the chunk walk and the pad byte.
  const extraBytes = extraChunk ? 8 + 5 + 1 : 0;
  const buffer = new ArrayBuffer(44 + extraBytes + dataBytes);
  const view = new DataView(buffer);
  const fourCC = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  fourCC(0, 'RIFF');
  view.setUint32(4, 36 + extraBytes + dataBytes, true);
  fourCC(8, 'WAVE');
  fourCC(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, bitsPerSample, true);

  let offset = 36;
  if (extraChunk) {
    fourCC(offset, 'LIST');
    view.setUint32(offset + 4, 5, true);
    offset += 8 + 5 + 1;
  }
  fourCC(offset, 'data');
  view.setUint32(offset + 4, dataBytes, true);
  for (let i = 0; i < frames; i++) view.setInt16(offset + 8 + i * 2, i, true);
  return buffer;
}

test('parses format and samples', () => {
  const { format, data } = parseWav(makeWav({ frames: 100 }));
  assert.deepEqual(format, { channels: 1, sampleRate: 24_000, bitsPerSample: 16 });
  assert.equal(data.byteLength, 200);
});

test('finds data past an interposed chunk rather than assuming byte 44', () => {
  const { data } = parseWav(makeWav({ frames: 50, extraChunk: true }));
  assert.equal(data.byteLength, 100);
});

test('joined length is the sum of the parts', () => {
  const { blob, totalSeconds, format } = concatWav([
    makeWav({ frames: 24_000 }),
    makeWav({ frames: 12_000 }),
  ]);
  assert.equal(format.sampleRate, 24_000);
  assert.equal(totalSeconds, 1.5);
  assert.equal(blob.size, 44 + (24_000 + 12_000) * 2);
});

test('the joined file is itself a valid WAV that round-trips', async () => {
  const { blob } = concatWav([makeWav({ frames: 10 }), makeWav({ frames: 20 })]);
  const { format, data } = parseWav(await blob.arrayBuffer());
  assert.deepEqual(format, { channels: 1, sampleRate: 24_000, bitsPerSample: 16 });
  assert.equal(data.byteLength, 60);
});

test('a single clip joins to itself unchanged', async () => {
  const { blob } = concatWav([makeWav({ frames: 7 })]);
  assert.equal((await blob.arrayBuffer()).byteLength, 44 + 14);
});

test('mismatched formats are refused, not silently concatenated', () => {
  // Joining these anyway would play the second half at the wrong speed.
  assert.throws(
    () => concatWav([makeWav({ frames: 10 }), makeWav({ frames: 10, sampleRate: 16_000 })]),
    (error: unknown) => error instanceof WavError && /16000 Hz/.test((error as Error).message),
  );
  assert.throws(() => concatWav([makeWav({ frames: 10 }), makeWav({ frames: 10, channels: 2 })]), WavError);
});

test('nothing to join is an error, not an empty file', () => {
  assert.throws(() => concatWav([]), WavError);
});

test('junk is rejected', () => {
  assert.throws(() => parseWav(new ArrayBuffer(4)), WavError);
  assert.throws(() => parseWav(new TextEncoder().encode('NOTAWAVEFILE....').buffer as ArrayBuffer), WavError);
});
