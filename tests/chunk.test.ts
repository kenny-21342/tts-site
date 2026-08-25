import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitForSynthesis } from '../lib/chunk.ts';

test('short text is one chunk, untouched', () => {
  assert.deepEqual(splitForSynthesis('侬好', 500), ['侬好']);
  assert.deepEqual(splitForSynthesis('  侬好  ', 500), ['侬好']);
});

test('blank input produces no chunks', () => {
  assert.deepEqual(splitForSynthesis('', 500), []);
  assert.deepEqual(splitForSynthesis('   \n ', 500), []);
});

test('cuts fall at sentence ends when it can manage it', () => {
  const text = '侬好。今朝天气老好额。阿拉一道去白相相。';
  const chunks = splitForSynthesis(text, 9);
  assert.deepEqual(chunks, ['侬好。', '今朝天气老好额。', '阿拉一道去白相相。']);
});

test('sentence-ending punctuation stays with its sentence', () => {
  for (const chunk of splitForSynthesis('侬好。谢谢侬！阿拉是上海人？', 7)) {
    assert.match(chunk, /[。！？]$/);
  }
});

test('falls back to clause commas when a sentence will not fit', () => {
  const chunks = splitForSynthesis('今朝天气老好额，阿拉一道去白相相，侬来伐。', 12);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 12, `too long: ${chunk}`);
});

test('a clause longer than a whole chunk is cut blind rather than dropped', () => {
  // Evenly, not greedily: 25 characters at a cap of 10 is three pieces of
  // 9/9/7, never 10/10/5 with a stub at the end.
  const chunks = splitForSynthesis('阿'.repeat(25), 10);
  assert.deepEqual(chunks, ['阿'.repeat(9), '阿'.repeat(9), '阿'.repeat(7)]);
  assert.equal(chunks.join('').length, 25);
});

test('no chunk ever exceeds the cap', () => {
  const text = '侬好。' + '今朝天气老好额，阿拉一道去白相相。'.repeat(40);
  for (const maxChars of [1, 2, 7, 13, 50, 499]) {
    for (const chunk of splitForSynthesis(text, maxChars)) {
      assert.ok(chunk.length <= maxChars, `cap ${maxChars} exceeded by ${chunk.length}`);
    }
  }
});

test('nothing is lost or invented', () => {
  // Interior whitespace is the one thing trimming may drop, so compare with it
  // removed — every other character must survive the round trip.
  const text = '侬好。今朝天气老好额，阿拉一道去白相相。谢谢侬！' + '阿'.repeat(30);
  for (const maxChars of [3, 9, 40]) {
    const rejoined = splitForSynthesis(text, maxChars).join('');
    assert.equal(rejoined.replace(/\s/g, ''), text.replace(/\s/g, ''), `cap ${maxChars}`);
  }
});

test('an oversized clause never orphans its punctuation into its own chunk', () => {
  // Greedy splitting of a 9-character sentence at a cap of 8 leaves '。' alone,
  // which is a paid synthesis of a full stop. Even pieces avoid it.
  const chunks = splitForSynthesis('阿拉一道去白相相。', 8);
  assert.deepEqual(chunks, ['阿拉一道去', '白相相。']);
  for (const chunk of chunks) {
    assert.ok(/[^。！？，、；：:,;!?]/.test(chunk), `punctuation-only chunk: ${chunk}`);
  }
});

test('a nonsense cap is rejected rather than looping forever', () => {
  assert.throws(() => splitForSynthesis('侬好', 0), RangeError);
});
