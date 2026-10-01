import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { textChunk } from '../src/chunks.js';

test('bounded chunks reconstruct Unicode text without splitting characters or accepting stale content', () => {
  const text = ('a😀漢ç\n' + 'x'.repeat(29)).repeat(1000);
  const expected = createHash('sha256').update(text).digest('hex');
  let offset = 0, reconstructed = '';
  for (;;) {
    const page = textChunk(text, offset, 33, expected);
    assert.ok(page.text.length <= 33);
    assert.ok(!page.text.endsWith('\ud83d'));
    assert.ok(!page.text.startsWith('\ude00'));
    assert.equal(page.contentSha256, expected);
    reconstructed += page.text;
    if (!page.hasMore) { assert.equal(page.nextOffset, text.length); break; }
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(reconstructed, text);
  assert.equal(textChunk('', 0, 2).hasMore, false);
  assert.throws(() => textChunk(text, text.length + 1), { code: 'INVALID_CURSOR' });
  assert.throws(() => textChunk('a😀z', 2), { code: 'INVALID_CURSOR' });
  assert.throws(() => textChunk(text + 'changed', 0, 33, expected), { code: 'CONTENT_CHANGED' });
});
