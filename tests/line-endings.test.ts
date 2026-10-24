import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CliAdapter, DELEGATION_GUIDANCE, taskPrompt, type Discovery, type Model } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { collectArtifacts } from '../src/artifacts.js';
import { clearLineEndingConversions, createProjectCopy, discardProjectCopy, previewProjectCopy, readLineEndingConversions, writeLineEndingConversions, type ProjectCopy } from '../src/isolation.js';
import { verifyCriteria } from '../src/verification.js';
import { convertCrlfToLf, listCopyFiles, normalizeEditedLineEndings, planLineEndings, restoreCrlfLineEndings, type LineEndingStyle } from '../src/line-endings.js';
import { StateStore } from '../src/state-store.js';
import { TaskManager } from '../src/task-manager.js';
import { BridgeError, type RunOptions } from '../src/types.js';

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

    // Styles as planLineEndings reports them before a run; mixed, new and binary originals have none.
    const originalMap: Record<string, LineEndingStyle | undefined> = {
      [origCrlfEditedLf]: 'crlf',
      [origLfEditedCrlf]: 'lf',
      [origMixedEditedMixed]: undefined,
      [newFileLf]: undefined,
      [origBinaryEditedMixed]: undefined,
      [alreadyCrlf]: 'crlf',
      [alreadyLf]: 'lf',
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

const FIXTURE: Record<string, string> = {
  'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  'untouched-crlf.txt': 'keep\r\nthis\r\n',
  'lf.txt': 'one\ntwo\n',
  'mixed.txt': 'a\r\nb\nc\r\n',
  'lone-cr.txt': 'a\rb\r\nc\r\n',
};

async function fixtureRepository(root: string, attributes?: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  for (const [name, content] of Object.entries(FIXTURE)) await writeFile(path.join(repo, name), content);
  if (attributes !== undefined) await writeFile(path.join(repo, '.gitattributes'), attributes);
  return repo;
}

function mockProcess() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = () => child.emit('close', 0);
  setImmediate(() => {
    child.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'line-endings-session' }) + '\n');
    child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
  });
  return child;
}

class CopyAdapter extends CliAdapter {
  onSpawn?: (cwd: string) => void;
  override spawnTask(_options: RunOptions, _model: string | undefined, cwd: string) {
    this.onSpawn?.(cwd);
    return mockProcess();
  }
  override async discover(): Promise<Discovery> {
    return { installed: true, path: 'mock-agy', authenticated: true, capabilities: { structuredOutput: true, streaming: true, sandbox: true,
      readOnlyMode: true, models: true, modelSelection: true, resume: true, sessionsList: false, cancel: false } };
  }
  override async listModels(): Promise<Model[]> {
    return [{ id: 'test-model', name: 'Test' }];
  }
}

async function withTaskManager(attributes: string | undefined, body: (repo: string, adapter: CopyAdapter, tasks: TaskManager) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-endings-run-'));
  const state = path.join(root, 'state');
  await mkdir(state);
  const repo = await fixtureRepository(root, attributes);
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_STATE_DIRECTORY: state, BRIDGE_TEST_EXECUTOR: 'agy' });
  const adapter = new CopyAdapter(config);
  const tasks = new TaskManager(adapter, config);
  try {
    await body(repo, adapter, tasks);
  } finally {
    await tasks.shutdown();
    for (const stored of new StateStore(state).load()) if (stored.project) await discardProjectCopy(stored.project);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

for (const [fixture, attributes] of [['no attributes', undefined], ['* text=auto', '* text=auto\n'], ['eol=crlf', '*.txt text eol=crlf\n']] as const) {
  test(`a delegated run sees pure CRLF files as LF and leaves the rest byte for byte (${fixture})`, async () => {
    await withTaskManager(attributes, async (repo, adapter, tasks) => {
      const seen = new Map<string, Buffer>();
      let found = false;
      adapter.onSpawn = cwd => {
        for (const name of Object.keys(FIXTURE)) seen.set(name, readFileSync(path.join(cwd, name)));
        // edit_file requires the target text to match exactly, and the model sends it with LF.
        const target = path.join(cwd, 'crlf.txt');
        const text = readFileSync(target, 'utf8');
        const at = text.indexOf('two\nthree\n');
        found = at >= 0;
        if (found) writeFileSync(target, text.slice(0, at) + 'TWO\nthree\n' + text.slice(at + 'two\nthree\n'.length));
      };
      assert.equal(FIXTURE['crlf.txt']!.indexOf('two\nthree\n'), -1, 'the search must fail against the CRLF original');

      const task = await tasks.run({ prompt: 'edit one line', workingDirectory: repo });
      await tasks.wait(task.taskId);
      assert.equal(tasks.status(task.taskId).status, 'completed');
      assert.equal(found, true);
      assert.equal(seen.get('crlf.txt')!.toString('utf8'), 'one\ntwo\nthree\n');
      assert.equal(seen.get('untouched-crlf.txt')!.toString('utf8'), 'keep\nthis\n');
      for (const name of ['lf.txt', 'mixed.txt', 'lone-cr.txt']) assert.deepEqual(seen.get(name), Buffer.from(FIXTURE[name]!), name);

      const preview = await tasks.preview(task.taskId);
      assert.deepEqual(preview.files, [{ status: 'M', path: 'crlf.txt' }]);
      assert.equal(preview.summary.insertions, 1);
      assert.equal(preview.summary.deletions, 1);

      const copy = tasks.status(task.taskId).copyDirectory!;
      assert.equal(await readFile(path.join(copy, 'crlf.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
      const untouched = Object.keys(FIXTURE).filter(name => name !== 'crlf.txt').concat(attributes === undefined ? [] : ['.gitattributes']);
      for (const name of untouched) assert.deepEqual(await readFile(path.join(copy, name)), await readFile(path.join(repo, name)), name);
      for (const [name, content] of Object.entries(FIXTURE)) assert.deepEqual(await readFile(path.join(repo, name)), Buffer.from(content), name);
    });
  });
}

test('a launch that fails after the conversion gets the original bytes back', async () => {
  await withTaskManager(undefined, async (repo, adapter, tasks) => {
    let copy = '';
    adapter.onSpawn = cwd => {
      copy = cwd;
      throw new BridgeError('AGY_NOT_FOUND', 'fixture launch failure');
    };
    const task = await tasks.run({ prompt: 'never starts', workingDirectory: repo });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).error?.code, 'AGY_NOT_FOUND');
    for (const [name, content] of Object.entries(FIXTURE)) assert.deepEqual(await readFile(path.join(copy, name)), Buffer.from(content), name);
    assert.equal((await tasks.preview(task.taskId)).files.length, 0);
  });
});

test('converted content renamed or copied by the CLI regains its original bytes (* text=auto)', async () => {
  await withTaskManager('* text=auto\n', async (repo, adapter, tasks) => {
    adapter.onSpawn = cwd => {
      renameSync(path.join(cwd, 'untouched-crlf.txt'), path.join(cwd, 'moved.txt'));
      copyFileSync(path.join(cwd, 'crlf.txt'), path.join(cwd, 'duplicate.txt'));
    };
    const task = await tasks.run({ prompt: 'move and copy', workingDirectory: repo });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).status, 'completed');
    const copy = tasks.status(task.taskId).copyDirectory!;
    assert.deepEqual(await readFile(path.join(copy, 'moved.txt')), Buffer.from(FIXTURE['untouched-crlf.txt']!));
    assert.deepEqual(await readFile(path.join(copy, 'duplicate.txt')), Buffer.from(FIXTURE['crlf.txt']!));
    assert.deepEqual(await readFile(path.join(copy, 'crlf.txt')), Buffer.from(FIXTURE['crlf.txt']!));
    const preview = await tasks.preview(task.taskId);
    assert.deepEqual(preview.files, [{ status: 'A', path: 'duplicate.txt' }, { status: 'A', path: 'moved.txt' }, { status: 'D', path: 'untouched-crlf.txt' }]);
  });
});

test('a resumed run converts files added earlier, and only the run that converted can release them', async () => {
  await withTaskManager(undefined, async (repo, adapter, tasks) => {
    adapter.onSpawn = cwd => writeFileSync(path.join(cwd, 'added.txt'), 'new\r\nfile\r\n');
    const first = await tasks.run({ prompt: 'add a file', workingDirectory: repo });
    await tasks.wait(first.taskId);
    assert.equal(tasks.status(first.taskId).status, 'completed');

    let seen: Buffer | undefined;
    adapter.onSpawn = cwd => { seen = readFileSync(path.join(cwd, 'added.txt')); };
    const second = await tasks.run({ prompt: 'resume', workingDirectory: repo, sessionId: 'line-endings-session' });
    await tasks.wait(second.taskId);
    assert.equal(tasks.status(second.taskId).status, 'completed');
    assert.equal(seen?.toString('utf8'), 'new\nfile\n');
    const copy = tasks.status(second.taskId).copyDirectory!;
    assert.equal(await readFile(path.join(copy, 'added.txt'), 'utf8'), 'new\r\nfile\r\n');

    // Both tasks share the copy. A conversion left by the second launch must survive a cleanup confirmed for the first.
    const manager = tasks as unknown as { tasks: Map<string, { project: ProjectCopy; record: { processCleanup?: unknown } }>; persist(taskId: string): void };
    const internal = manager.tasks;
    const project = internal.get(second.taskId)!.project;
    const verified = { verified: true, spawnedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), remaining: 0 };
    const { conversions } = await planLineEndings(copy, ['crlf.txt']);
    await writeLineEndingConversions(project, { taskId: second.taskId, files: conversions, existingBefore: await listCopyFiles(copy) });
    await convertCrlfToLf(copy, conversions);
    internal.get(first.taskId)!.record.processCleanup = verified;
    manager.persist(first.taskId);
    await assert.rejects(tasks.integrate(first.taskId, '0'.repeat(64)), { code: 'TASK_NOT_READY' });
    assert.equal((await readLineEndingConversions(project))?.taskId, second.taskId);
    assert.equal(await readFile(path.join(copy, 'crlf.txt'), 'utf8'), 'one\ntwo\nthree\n');

    internal.get(second.taskId)!.record.processCleanup = verified;
    manager.persist(second.taskId);
    await assert.rejects(tasks.integrate(second.taskId, '0'.repeat(64)), { code: 'REVIEW_CHANGED' });
    assert.equal(await readLineEndingConversions(project), undefined);
    assert.deepEqual(await readFile(path.join(copy, 'crlf.txt')), Buffer.from(FIXTURE['crlf.txt']!));
    for (const [name, content] of Object.entries(FIXTURE)) assert.deepEqual(await readFile(path.join(repo, name)), Buffer.from(content), name);
  });
});

test('restoring keeps edits, isolated CRs and deletions, and an unrestored copy cannot be previewed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-endings-restore-'));
  try {
    execFileSync('git', ['init', '--quiet', dir]);
    await writeFile(path.join(dir, 'a.txt'), 'x\r\ny\r\n');
    await writeFile(path.join(dir, 'b.txt'), 'p\r\nq\r\n');
    await writeFile(path.join(dir, 'c.txt'), 'r\r\ns\r\n');
    await writeFile(path.join(dir, 'lf.txt'), 'x\ny\n');
    await writeFile(path.join(dir, '.gitignore'), 'hidden.txt\ncache/\n');
    const copy = await createProjectCopy(dir);
    try {
      const { styles, conversions } = await planLineEndings(copy.copyDirectory, [...copy.baseline.keys()]);
      assert.deepEqual([...styles], [['.gitignore', 'lf'], ['a.txt', 'crlf'], ['b.txt', 'crlf'], ['c.txt', 'crlf'], ['lf.txt', 'lf']]);
      // lf.txt and the ignored hidden.txt hold exactly the LF form of a.txt; files present before the run are never taken
      // for renamed copies, even when they become visible only afterwards.
      await writeFile(path.join(copy.copyDirectory, 'hidden.txt'), 'x\ny\n');
      const existingBefore = await listCopyFiles(copy.copyDirectory);
      assert.ok(existingBefore.includes('hidden.txt'));
      assert.deepEqual(conversions.map(conversion => conversion.path), ['a.txt', 'b.txt', 'c.txt']);
      // A stop between recording the plan and converting every file leaves c.txt still CRLF.
      await writeLineEndingConversions(copy, { taskId: 'fixture-task', files: conversions, existingBefore });
      assert.deepEqual(await convertCrlfToLf(copy.copyDirectory, conversions.slice(0, 2)), ['a.txt', 'b.txt']);
      await assert.rejects(previewProjectCopy(copy), { code: 'LINE_ENDINGS_UNRESTORED' });
      await assert.rejects(collectArtifacts(copy, ['a.txt']), { code: 'LINE_ENDINGS_UNRESTORED' });
      await assert.rejects(verifyCriteria(copy, '0'.repeat(64)), { code: 'LINE_ENDINGS_UNRESTORED' });

      await writeFile(path.join(copy.copyDirectory, 'a.txt'), 'x\nnew\ry\n');
      // b.txt only moves into an ignored directory; its content still regains the original bytes.
      await mkdir(path.join(copy.copyDirectory, 'cache'));
      await rename(path.join(copy.copyDirectory, 'b.txt'), path.join(copy.copyDirectory, 'cache', 'b.txt'));
      assert.deepEqual(await restoreCrlfLineEndings(copy.copyDirectory, conversions, existingBefore), ['a.txt', 'cache/b.txt']);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'cache', 'b.txt'), 'utf8'), 'p\r\nq\r\n');
      assert.equal(await readFile(path.join(copy.copyDirectory, 'lf.txt'), 'utf8'), 'x\ny\n');
      assert.equal(await readFile(path.join(copy.copyDirectory, 'hidden.txt'), 'utf8'), 'x\ny\n');
      await rm(path.join(copy.copyDirectory, 'hidden.txt'));
      assert.equal(await readFile(path.join(copy.copyDirectory, 'a.txt'), 'utf8'), 'x\r\nnew\ry\r\n');
      assert.equal(await readFile(path.join(copy.copyDirectory, 'c.txt'), 'utf8'), 'r\r\ns\r\n');
      assert.deepEqual(await restoreCrlfLineEndings(copy.copyDirectory, conversions, existingBefore), []);
      await clearLineEndingConversions(copy);
      assert.deepEqual((await previewProjectCopy(copy)).files, [{ status: 'M', path: 'a.txt' }, { status: 'D', path: 'b.txt' }]);

      // A converted file that grows past the limit is never released with LF lines.
      await writeFile(path.join(copy.copyDirectory, 'c.txt'), 'r\n' + 'x'.repeat(16 * 1024 * 1024) + '\n');
      await assert.rejects(restoreCrlfLineEndings(copy.copyDirectory, conversions.slice(2), existingBefore), { code: 'LINE_ENDINGS_UNRESTORED' });
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

    const original = async (): Promise<LineEndingStyle> => 'lf';
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
        return 'crlf';
      }),
      { code: 'UNSAFE_PROJECT_PATH' },
    );

    assert.equal(await readFile(path.join(dir, 'outside', 'f.txt'), 'utf8'), 'external\n');
    await mkdir(path.join(dir, 'copy', '..fixtures'), { recursive: true });
    await writeFile(path.join(dir, 'copy', '..fixtures', 'g.txt'), 'a\nb\n');
    assert.deepEqual(await normalizeEditedLineEndings(path.join(dir, 'copy'), ['..fixtures/g.txt'], async (): Promise<LineEndingStyle> => 'crlf'), ['..fixtures/g.txt']);
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
