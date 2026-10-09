import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';

test('persisted result contracts reject corrupt hashes, artifacts and output schemas', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-result-state-'));
  try {
    const store = new StateStore(directory);
    const taskId = randomUUID();
    const workingDirectory = path.join(directory, 'project');
    store.save({ ownerPid: process.pid, events: [], cursor: 0,
      options: { prompt: 'Public result state fixture', workingDirectory },
      record: { taskId, prompt: 'Public result state fixture', workingDirectory, status: 'completed', createdAt: new Date().toISOString() } });
    const target = path.join(directory, taskId + '.json');
    const original = JSON.parse(await readFile(target, 'utf8'));
    const valid = { value: { answer: 42 }, sha256: 'a'.repeat(64) };
    const snapshot = structuredClone(original);
    snapshot.record.structuredResult = valid;
    snapshot.record.artifacts = [{ path: 'result.json', sha256: 'b'.repeat(64), bytes: 17 }];
    snapshot.record.outputSchema = { type: 'object' };
    snapshot.options.outputSchema = { type: 'object' };
    snapshot.options.artifactPaths = ['result.json'];
    await writeFile(target, JSON.stringify(snapshot));
    const loaded = store.load()[0]!.record as typeof original.record;
    assert.deepEqual(loaded.structuredResult, valid);
    assert.deepEqual(loaded.artifacts, snapshot.record.artifacts);
    const mutations = [
      { field: 'structuredResult', value: { value: 42, sha256: 'bad' } },
      { field: 'structuredResult', value: { sha256: 'a'.repeat(64) } },
      { field: 'artifacts', value: [{ path: 'result.json', sha256: 'bad', bytes: 17 }] },
      { field: 'artifacts', value: [{ path: '', sha256: 'a'.repeat(64), bytes: 17 }] },
      { field: 'artifacts', value: [{ path: 'result.json', sha256: 'a'.repeat(64), bytes: -1 }] },
      { field: 'artifacts', value: Array.from({ length: 101 }, () => ({ path: 'result.json', sha256: 'a'.repeat(64), bytes: 0 })) },
      { field: 'outputSchema', value: false },
      { field: 'artifactPaths', value: [] },
    ];
    for (const mutation of mutations) {
      const corrupt = structuredClone(original); corrupt.record[mutation.field] = mutation.value;
      await writeFile(target, JSON.stringify(corrupt));
      assert.throws(() => store.load(), { code: 'INVALID_STATE' }, mutation.field);
    }
    const corruptOptions = structuredClone(original); corruptOptions.options.outputSchema = [];
    await writeFile(target, JSON.stringify(corruptOptions));
    assert.throws(() => store.load(), { code: 'INVALID_STATE' });
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-result-state-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
