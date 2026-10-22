import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DELEGATION_GUIDANCE, taskPrompt } from '../src/cli-adapter.js';
import { createProjectCopy, discardProjectCopy, readBaselineFile } from '../src/isolation.js';
import { normalizeEditedLineEndings } from '../src/line-endings.js';

async function file(dir: string, name: string, content?: string | Uint8Array): Promise<Buffer> {
  const target = path.join(dir, name);
  if (content !== undefined) {
    await writeFile(target, content);
  }
  return readFile(target);
}

test('normalizeEditedLineEndings handles mixed and untouched files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-'));
  try {
    const crlfMixed = 'a\r\nb\nc\r\n';
    const lfMixed = 'a\nb\r\nc\n';
    const onlyCrlf = 'a\r\nb\r\n';
    const onlyLf = 'a\nb\n';
    const withNull = Buffer.from([0x61, 0x00, 0x62, 0x0d, 0x0a, 0x63, 0x0a]);
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x61, 0x0a]);
    const isolatedCr = 'start\rmiddle\r\nend\n';

    await file(dir, 'crlf-mixed.txt', crlfMixed);
    await file(dir, 'lf-mixed.txt', lfMixed);
    await file(dir, 'only-crlf.txt', onlyCrlf);
    await file(dir, 'only-lf.txt', onlyLf);
    await file(dir, 'zero.bin', withNull);
    await file(dir, 'invalid-utf8.bin', invalidUtf8);
    await file(dir, 'isolated-cr.txt', isolatedCr);

    const modified = await normalizeEditedLineEndings(dir, [
      'crlf-mixed.txt',
      'lf-mixed.txt',
      'only-crlf.txt',
      'only-lf.txt',
      'zero.bin',
      'invalid-utf8.bin',
      'isolated-cr.txt',
    ]);

    assert.deepEqual(modified, ['crlf-mixed.txt', 'lf-mixed.txt']);
    assert.equal((await file(dir, 'crlf-mixed.txt')).toString('utf8'), 'a\r\nb\r\nc\r\n');
    assert.equal((await file(dir, 'lf-mixed.txt')).toString('utf8'), 'a\nb\nc\n');
    assert.deepEqual(await file(dir, 'only-crlf.txt'), Buffer.from(onlyCrlf));
    assert.deepEqual(await file(dir, 'only-lf.txt'), Buffer.from(onlyLf));
    assert.deepEqual(await file(dir, 'zero.bin'), withNull);
    assert.deepEqual(await file(dir, 'invalid-utf8.bin'), invalidUtf8);
    assert.equal((await file(dir, 'isolated-cr.txt')).toString('utf8'), isolatedCr);

    await assert.rejects(normalizeEditedLineEndings(dir, ['../outside.txt']));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('normalizeEditedLineEndings restores the original line ending style', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-orig-'));
  try {
    const origCrlfEditedLf = 'crlf-to-lf.txt';
    const origLfEditedCrlf = 'lf-to-crlf.txt';
    const origMixedEditedMixed = 'mixed.txt';
    const newFileLf = 'new-file.txt';
    const origBinaryEditedMixed = 'binary.txt';
    const alreadyCrlf = 'already-crlf.txt';
    const alreadyLf = 'already-lf.txt';

    await file(dir, origCrlfEditedLf, 'a\nb\n');
    await file(dir, origLfEditedCrlf, 'a\r\nb\r\n');
    await file(dir, origMixedEditedMixed, 'a\r\nb\nc\r\n');
    await file(dir, newFileLf, 'a\nb\n');
    await file(dir, origBinaryEditedMixed, 'a\r\nb\nc\r\n');
    await file(dir, alreadyCrlf, 'a\r\nb\r\n');
    await file(dir, alreadyLf, 'a\nb\n');

    const originalMap: Record<string, Buffer | undefined> = {
      [origCrlfEditedLf]: Buffer.from('orig\r\ncontent\r\n'),
      [origLfEditedCrlf]: Buffer.from('orig\ncontent\n'),
      [origMixedEditedMixed]: Buffer.from('orig\r\nmixed\n'),
      [newFileLf]: undefined,
      [origBinaryEditedMixed]: Buffer.from([0x61, 0x00, 0x62, 0x0d, 0x0a]),
      [alreadyCrlf]: Buffer.from('orig\r\ncontent\r\n'),
      [alreadyLf]: Buffer.from('orig\ncontent\n'),
    };

    const modified = await normalizeEditedLineEndings(
      dir,
      [
        origCrlfEditedLf,
        origLfEditedCrlf,
        origMixedEditedMixed,
        newFileLf,
        origBinaryEditedMixed,
        alreadyCrlf,
        alreadyLf,
      ],
      async (rel) => originalMap[rel],
    );

    assert.deepEqual(modified, [
      origCrlfEditedLf,
      origLfEditedCrlf,
      origMixedEditedMixed,
      origBinaryEditedMixed,
    ]);
    assert.equal((await file(dir, origCrlfEditedLf)).toString('utf8'), 'a\r\nb\r\n');
    assert.equal((await file(dir, origLfEditedCrlf)).toString('utf8'), 'a\nb\n');
    assert.equal((await file(dir, origMixedEditedMixed)).toString('utf8'), 'a\r\nb\r\nc\r\n');
    assert.equal((await file(dir, newFileLf)).toString('utf8'), 'a\nb\n');
    assert.equal((await file(dir, origBinaryEditedMixed)).toString('utf8'), 'a\r\nb\r\nc\r\n');
    assert.equal((await file(dir, alreadyCrlf)).toString('utf8'), 'a\r\nb\r\n');
    assert.equal((await file(dir, alreadyLf)).toString('utf8'), 'a\nb\n');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('edited copies regain the baseline line endings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-baseline-'));
  try {
    execFileSync('git', ['init', '--quiet', dir]);
    await writeFile(path.join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');

    const copy = await createProjectCopy(dir, ['crlf.txt']);
    try {
      assert.deepEqual(await readBaselineFile(copy, 'crlf.txt'), Buffer.from('one\r\ntwo\r\n'));
      assert.equal(await readBaselineFile(copy, 'absent.txt'), undefined);

      await writeFile(path.join(copy.copyDirectory, 'crlf.txt'), 'one\nchanged\n');
      const modified = await normalizeEditedLineEndings(
        copy.copyDirectory,
        ['crlf.txt'],
        relative => readBaselineFile(copy, relative),
      );
      assert.deepEqual(modified, ['crlf.txt']);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'crlf.txt'), 'utf8'), 'one\r\nchanged\r\n');
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('normalization is idempotent and leaves isolated carriage returns alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-idempotent-'));
  try {
    const ambiguous = 'a\r\r\n';
    const plain = 'x\ny\n';
    await file(dir, 'ambiguous.txt', ambiguous);
    await file(dir, 'plain.txt', plain);

    const original = async () => Buffer.from('o\no\n');
    const first = await normalizeEditedLineEndings(dir, ['ambiguous.txt', 'plain.txt'], original);
    const second = await normalizeEditedLineEndings(dir, ['ambiguous.txt', 'plain.txt'], original);

    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.deepEqual(await file(dir, 'ambiguous.txt'), Buffer.from(ambiguous));
    assert.deepEqual(await file(dir, 'plain.txt'), Buffer.from(plain));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a directory swapped for a link during normalization is never written through', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-link-'));
  try {
    await mkdir(path.join(dir, 'copy', 'sub'), { recursive: true });
    await mkdir(path.join(dir, 'outside'), { recursive: true });
    await writeFile(path.join(dir, 'copy', 'sub', 'f.txt'), 'a\nb\n');
    await writeFile(path.join(dir, 'outside', 'f.txt'), 'external\n');

    await assert.rejects(
      normalizeEditedLineEndings(path.join(dir, 'copy'), ['sub/f.txt'], async () => {
        await rename(path.join(dir, 'copy', 'sub'), path.join(dir, 'copy', 'sub-moved'));
        await symlink(path.join(dir, 'outside'), path.join(dir, 'copy', 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
        return Buffer.from('o\r\no\r\n');
      }),
      { code: 'UNSAFE_PROJECT_PATH' },
    );

    assert.equal(await readFile(path.join(dir, 'outside', 'f.txt'), 'utf8'), 'external\n');
    await mkdir(path.join(dir, 'copy', '..fixtures'), { recursive: true });
    await writeFile(path.join(dir, 'copy', '..fixtures', 'g.txt'), 'a\nb\n');
    assert.deepEqual(await normalizeEditedLineEndings(path.join(dir, 'copy'), ['..fixtures/g.txt'], async () => Buffer.from('o\r\no\r\n')), ['..fixtures/g.txt']);
    assert.equal(await readFile(path.join(dir, 'copy', '..fixtures', 'g.txt'), 'utf8'), 'a\r\nb\r\n');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('task prompt includes delegation guidance', () => {
  const prompt = taskPrompt({ prompt: 'x', workingDirectory: os.tmpdir() } as never, 1_000_000);
  assert.equal(prompt.endsWith(DELEGATION_GUIDANCE), true);
  assert.equal(prompt.includes(DELEGATION_GUIDANCE), true);
  assert.equal(DELEGATION_GUIDANCE.includes('node_modules'), true);
  assert.equal(DELEGATION_GUIDANCE.includes('line endings'), true);
  assert.equal(DELEGATION_GUIDANCE.includes('full signature'), true);
  assert.equal(DELEGATION_GUIDANCE.includes('temporary, scratch or test files'), true);
});
