/**
 * Splitting long text into synthesis-sized pieces.
 *
 * The API caps a single request, so anything longer has to arrive as several
 * requests whose audio is stitched back together. Where the cuts fall is
 * audible: a break mid-clause leaves a swallowed syllable and a wrong-sounding
 * pause, because each chunk is synthesised without knowing its neighbours.
 * So the splitter prefers sentence ends, falls back to clause commas, and only
 * cuts blind when a single clause is itself too long.
 *
 * Chinese text carries its own punctuation set (。！？；，、) and rarely uses
 * spaces, so word-boundary splitting of the kind that works for English is not
 * available here.
 */

/** Ends a sentence. A cut here is inaudible. */
const SENTENCE_END = /[。！？!?；;\n]/;

/** Ends a clause. A cut here is audible but natural. */
const CLAUSE_END = /[，,、：:]/;

/**
 * Split on a punctuation class, keeping the punctuation attached to the piece
 * it closes — dropping it would change how the sentence is read aloud.
 */
function splitKeepingDelimiters(text: string, delimiter: RegExp): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const character of text) {
    current += character;
    if (delimiter.test(character)) {
      pieces.push(current);
      current = '';
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Greedily pack pieces into chunks, never exceeding `maxChars`. */
function pack(pieces: string[], maxChars: number, splitOversized: (piece: string) => string[]): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    if (piece.length > maxChars) {
      // This piece cannot fit on its own; flush what we have and break it down.
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitOversized(piece));
      continue;
    }
    if (current.length + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Last resort: a clause longer than a whole chunk, cut blind.
 *
 * The cuts are spread evenly rather than taken greedily at `maxChars`. Filling
 * each piece to the brim leaves whatever is left over in the last one, and
 * that remainder is regularly a single character — for text ending in 。 or ！
 * that means shipping a chunk which is nothing but punctuation, and paying for
 * a synthesis of it. Even pieces cannot produce a remainder at all.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const pieces = Math.ceil(text.length / maxChars);
  const size = Math.ceil(text.length / pieces);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

/**
 * Split `text` into pieces of at most `maxChars`, cutting at the least
 * audible boundary available. Returns `[]` for blank input, and always
 * returns pieces whose concatenation is the trimmed input with interior
 * whitespace preserved.
 */
export function splitForSynthesis(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new RangeError('maxChars must be at least 1');

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const byClause = (sentence: string) =>
    pack(splitKeepingDelimiters(sentence, CLAUSE_END), maxChars, (clause) => hardSplit(clause, maxChars));

  return pack(splitKeepingDelimiters(trimmed, SENTENCE_END), maxChars, byClause)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}
