import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));

const fixtureSource = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
test('fixture', () => {
  fs.writeFileSync(process.env.FIXTURE_OUTPUT, os.tmpdir());
  fs.mkdirSync(path.join(os.tmpdir(), 'agy-mcp-copy-leftover'));
  if (process.env.FIXTURE_FAILS) throw new Error('expected failure');
});
`;

function workspace(): { base: string; temp: string; fixture: string; output: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
  const temp = path.join(base, 'temp');
  mkdirSync(temp);
  const fixture = path.join(base, 'fixture.mjs');
  writeFileSync(fixture, fixtureSource);
  return { base, temp, fixture, output: path.join(base, 'output.txt') };
}

function run(temp: string, fixture: string, output: string, fails: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, FIXTURE_OUTPUT: output, ...(fails ? { FIXTURE_FAILS: '1' } : {}) };
  // A runner started inside another one would report to it instead of running the file.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, fixture], { env, encoding: 'utf8' });
}

test('a run works in its own temp directory, removes it and keeps the exit code of the tests', () => {
  const { base, temp, fixture, output } = workspace();
  try {
    for (const fails of [false, true]) {
      rmSync(output, { force: true });
      const result = run(temp, fixture, output, fails);
      assert.equal(result.status, fails ? 1 : 0, result.stderr);
      if (fails) assert.match(result.stdout, /expected failure/);
      const used = readFileSync(output, 'utf8');
      assert.equal(path.dirname(used), temp);
      assert.match(path.basename(used), /^agt-/);
      assert.deepEqual(readdirSync(temp), []);
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a run removes only earlier runs whose owner has ended and whose directory stopped changing', () => {
  const { base, temp, fixture, output } = workspace();
  try {
    const endedPid = spawnSync(process.execPath, ['-e', '']).pid;
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const owned: Array<[string, string?]> = [
      ['agt-dead', String(endedPid)],
      ['agt-live', String(process.pid)],
      ['agt-badpid', 'abc'],
      ['agt-nopid'],
      ['unrelated', String(endedPid)],
    ];
    for (const [name, owner] of owned) {
      mkdirSync(path.join(temp, name));
      if (owner) writeFileSync(path.join(temp, name, '.owner-pid'), owner);
      utimesSync(path.join(temp, name), longAgo, longAgo);
    }
    // The owner has ended but the directory changed just now, as when its tests outlive the run that started them.
    mkdirSync(path.join(temp, 'agt-recent'));
    writeFileSync(path.join(temp, 'agt-recent', '.owner-pid'), String(endedPid));
    const result = run(temp, fixture, output, false);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(temp).sort(), ['agt-badpid', 'agt-live', 'agt-nopid', 'agt-recent', 'unrelated']);
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a directory that could not be removed keeps its owner file so a later run can retry', { skip: process.platform !== 'win32' }, async () => {
  const { base, temp, fixture, output } = workspace();
  try {
    const stuck = path.join(temp, 'agt-stuck');
    const busy = path.join(stuck, 'busy');
    mkdirSync(busy, { recursive: true });
    const endedPid = String(spawnSync(process.execPath, ['-e', '']).pid);
    writeFileSync(path.join(stuck, '.owner-pid'), endedPid);
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stuck, longAgo, longAgo);
    // Windows refuses to remove the working directory of a running process.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: busy, stdio: 'ignore' });
    try {
      const result = run(temp, fixture, output, false);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Não foi possível remover/);
      assert.equal(readFileSync(path.join(stuck, '.owner-pid'), 'utf8'), endedPid);
    } finally {
      holder.kill();
      await once(holder, 'close');
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
