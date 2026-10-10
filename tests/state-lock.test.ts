import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore, processAlive } from '../src/state-store.js';

test('concurrent stale registry recovery cannot remove a new live owner lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-lock-test-'));
  const children: ReturnType<typeof spawn>[] = [], done: Promise<{ status: string; code?: string }>[] = [];
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../tests/state-lock-process.mjs', import.meta.url)), mode, root, new URL('../src/state-store.js', import.meta.url).href], { windowsHide: true });
    children.push(child);
    const result = new Promise<{ status: string; code?: string }>((resolve, reject) => {
      let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
      child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output.trim())); } catch (error) { reject(error); } });
    }); done.push(result); return result;
  };
  const until = async (predicate: () => boolean) => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw Error('Fixture signal timed out'); await delay(10); } };
  try {
    const store = new StateStore(path.join(root, 'state')); assert.equal(processAlive(99999999), false);
    await writeFile(path.join(root, 'state', 'registry.lock'), JSON.stringify({ pid: 99999999 }));
    const b = launch('b'); await until(() => existsSync(path.join(root, 'b-ready')));
    let aDone = false; const a = launch('a').then(value => { aDone = true; return value; });
    await until(() => aDone || existsSync(path.join(root, 'a-ready')));
    if (aDone) {
      assert.deepEqual(await a, { status: 'failed', code: 'STATE_BUSY' });
      writeFileSync(path.join(root, 'b-go'), '1'); assert.equal((await b).status, 'success');
    } else {
      writeFileSync(path.join(root, 'b-go'), '1'); const observed = await b;
      writeFileSync(path.join(root, 'a-go'), '1'); await a;
      assert.equal(observed.code, 'STATE_BUSY', 'A recovering contender deleted a different live registry lock');
    }
    const release = store.acquire('registry'); release();
  } finally {
    writeFileSync(path.join(root, 'a-go'), '1'); writeFileSync(path.join(root, 'b-go'), '1');
    await Promise.allSettled(done); for (const child of children) if (child.exitCode === null) child.kill();
    assert.equal(path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))), ''); assert.ok(path.basename(root).startsWith('agy-state-lock-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('state lock release preserves a replaced file even when ownership JSON is copied', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-lock-test-'));
  try {
    const state = path.join(root, 'state'), store = new StateStore(state), release = store.acquire('registry'), file = path.join(state, 'registry.lock');
    const original = readFileSync(file, 'utf8'); renameSync(file, file + '.original'); writeFileSync(file, original);
    assert.throws(release, { code: 'STATE_BUSY' }); assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    assert.equal(path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))), ''); assert.ok(path.basename(root).startsWith('agy-state-lock-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('live, malformed and abandoned recovery locks stay intact; legacy stale locks and repeated release are safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-lock-test-'));
  try {
    const state = path.join(root, 'state'), store = new StateStore(state), file = path.join(state, 'registry.lock');
    const release = store.acquire('registry');
    assert.throws(() => store.acquire('registry'), { code: 'STATE_BUSY' }); release();
    const second = store.acquire('registry'); release(); assert.equal(existsSync(file), true); second();
    for (const raw of ['{', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: 99999999, token: 'invalid' }), 'x'.repeat(1025)]) {
      writeFileSync(file, raw); assert.throws(() => store.acquire('registry'), { code: 'STATE_BUSY' }); assert.equal(readFileSync(file, 'utf8'), raw);
    }
    const legacy = JSON.stringify({ pid: 99999999 }); writeFileSync(file, legacy);
    const gate = file + '.recovery'; writeFileSync(gate, legacy);
    assert.throws(() => store.acquire('registry'), { code: 'STATE_BUSY' });
    assert.equal(readFileSync(file, 'utf8'), legacy); assert.equal(readFileSync(gate, 'utf8'), legacy);
    await rm(gate); const recovered = store.acquire('registry'); recovered(); assert.equal(existsSync(file), false);
  } finally {
    assert.equal(path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))), ''); assert.ok(path.basename(root).startsWith('agy-state-lock-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
