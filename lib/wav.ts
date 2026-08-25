/**
 * Joining several WAV clips into one.
 *
 * Every clip comes back from the same model in the same shape (24 kHz mono
 * 16-bit PCM), so joining them is a matter of concatenating the sample data
 * and writing one new header — no decoding, no resampling, no quality loss.
 * Decoding through the Web Audio API would work too, but it resamples to the
 * AudioContext's rate and would hand back something subtly different from what
 * was synthesised.
 *
 * The format is verified rather than assumed: if the API ever answers with a
 * different rate or channel count for one chunk, silently concatenating would
 * produce a file that plays at the wrong speed from that point on.
 */

const HEADER_BYTES = 44;

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavError';
  }
}

export type WavFormat = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

type ParsedWav = { format: WavFormat; data: Uint8Array };

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Pull the format and the raw samples out of one WAV.
 *
 * The chunks are walked rather than read at fixed offsets: a WAV is only
 * guaranteed to start with `RIFF....WAVE`, and real encoders put `LIST` or
 * `fact` chunks before `data` often enough that assuming byte 44 is wrong.
 */
export function parseWav(buffer: ArrayBuffer): ParsedWav {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) throw new WavError('Not a WAV: too short.');
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
    throw new WavError('Not a WAV: missing the RIFF/WAVE marker.');
  }

  let format: WavFormat | null = null;
  let data: Uint8Array | null = null;
  let offset = 12;

  while (offset + 8 <= buffer.byteLength) {
    const id = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // Clamp: a truncated download can declare more data than it carries.
      const end = Math.min(body + size, buffer.byteLength);
      data = new Uint8Array(buffer, body, end - body);
    }

    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!format) throw new WavError('WAV has no fmt chunk.');
  if (!data) throw new WavError('WAV has no data chunk.');
  return { format, data };
}

function sameFormat(a: WavFormat, b: WavFormat): boolean {
  return a.channels === b.channels && a.sampleRate === b.sampleRate && a.bitsPerSample === b.bitsPerSample;
}

export function describeFormat(format: WavFormat): string {
  return `${format.sampleRate} Hz ${format.channels === 1 ? 'mono' : `${format.channels}ch`} ${format.bitsPerSample}-bit`;
}

/**
 * Concatenate WAVs of identical format into a single WAV.
 *
 * @throws {WavError} if the list is empty or the formats disagree.
 */
export function concatWav(buffers: ArrayBuffer[]): { blob: Blob; format: WavFormat; totalSeconds: number } {
  if (buffers.length === 0) throw new WavError('Nothing to join.');

  const parsed = buffers.map(parseWav);
  const format = parsed[0].format;

  for (const [index, part] of parsed.entries()) {
    if (!sameFormat(part.format, format)) {
      throw new WavError(
        `Clip ${index + 1} is ${describeFormat(part.format)}, but the first is ${describeFormat(format)}.`,
      );
    }
  }

  const dataBytes = parsed.reduce((total, part) => total + part.data.byteLength, 0);
  const output = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(output.buffer);
  const bytesPerFrame = (format.channels * format.bitsPerSample) / 8;

  const writeFourCC = (offset: number, text: string) => {
    for (let index = 0; index < 4; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeFourCC(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeFourCC(8, 'WAVE');
  writeFourCC(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeFourCC(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (const part of parsed) {
    output.set(part.data, offset);
    offset += part.data.byteLength;
  }

  return {
    blob: new Blob([output], { type: 'audio/wav' }),
    format,
    totalSeconds: dataBytes / (format.sampleRate * bytesPerFrame),
  };
}
