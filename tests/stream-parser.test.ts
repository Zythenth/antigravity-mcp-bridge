import assert from 'node:assert/strict';
import test from 'node:test';
import { LineParser } from '../src/stream-parser.js';

for (const fragments of [
  ['x'.repeat(17) + '\nnext\n'],
  ['x'.repeat(9), 'x'.repeat(8), '\nnext\n'],
  ['x'.repeat(17), '{"ok":true}', '\nnext\n'],
]) {
  test(`oversized frames are discarded through the newline (${fragments.length} chunks)`, () => {
    const lines: string[] = [];
    let rejected = 0;
    const parser = new LineParser(line => lines.push(line), 16, () => rejected++);
    for (const fragment of fragments) parser.write(Buffer.from(fragment));
    parser.end();
    assert.deepEqual(lines, ['next']);
    assert.equal(rejected, 1);
  });
}

test('oversized final frames never emit a prefix or tail at EOF', () => {
  const lines: string[] = [];
  const parser = new LineParser(line => lines.push(line), 8);
  parser.write(Buffer.from('x'.repeat(9)));
  parser.write(Buffer.from('tail'));
  parser.end();
  assert.deepEqual(lines, []);
});

test('line limits apply independently to every frame within a single chunk', () => {
  const lines: string[] = [];
  const parser = new LineParser(line => lines.push(line), 8);
  parser.write(Buffer.from('first\n' + 'x'.repeat(9) + '\n12345678\nlast'));
  parser.end();
  assert.deepEqual(lines, ['first', '12345678', 'last']);
});

test('UTF-8 split at each byte retains valid frames and recovers after overflow', () => {
  const lines: string[] = [];
  let rejected = 0;
  const parser = new LineParser(line => lines.push(line), 8, () => rejected++);
  for (const byte of Buffer.from('Olá 🌍\r\n' + 'á'.repeat(9) + '\nfim 🌍')) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(lines, ['Olá 🌍', 'fim 🌍']);
  assert.equal(rejected, 1);
});

test('one oversized stream reports one rejection regardless of chunk count', () => {
  const lines: string[] = [];
  let rejected = 0;
  const parser = new LineParser(line => lines.push(line), 8, () => rejected++);
  for (let index = 0; index < 1000; index++) parser.write(Buffer.from('0123456789'));
  parser.write(Buffer.from('\n\r\nokay\n'));
  parser.end();
  assert.deepEqual(lines, ['okay']);
  assert.equal(rejected, 1);
});
