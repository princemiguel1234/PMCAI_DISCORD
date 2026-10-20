import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiscordMessage } from '../src/format.js';

test('keeps Discord chunks under the configured character limit', () => {
  const chunks = splitDiscordMessage('hello '.repeat(1200), 1900);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'hello '.repeat(1200).trim());
});

test('does not split a Unicode surrogate pair', () => {
  const input = `${'a'.repeat(1899)}😀tail`;
  const chunks = splitDiscordMessage(input, 1900);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].endsWith('\uD83D'), false);
  assert.equal(chunks[1].startsWith('\uDE00'), false);
  assert.equal(chunks.join(''), input);
});

test('prefers a newline or space boundary and handles empty output', () => {
  const chunks = splitDiscordMessage(`${'a'.repeat(100)} ${'b'.repeat(100)}`, 120);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 100);
  assert.deepEqual(splitDiscordMessage('   '), ['I could not generate a text response.']);
});
