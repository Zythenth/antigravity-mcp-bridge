import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bridge copies that tests never discard stay in the temp directory, so each run works in one of its own and removes it whole.
// The prefix is short because it lengthens every path the tests create.
const PREFIX = 'agt-';
const OWNER_FILE = '.owner-pid';
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function remove(directory) {
  try {
    // The owner file goes last: later runs skip a directory without one, so a removal that stops halfway can still be retried.
    for (const name of readdirSync(directory)) {
      if (name !== OWNER_FILE) rmSync(path.join(directory, name), REMOVE_OPTIONS);
    }
    rmSync(directory, REMOVE_OPTIONS);
  } catch (error) {
    console.error(`Não foi possível remover ${directory}: ${error.message}`);
  }
}

// A run that was killed could not remove its directory. Its tests may outlive it, so besides a recorded owner that has ended,
// the directory must have stopped changing: a live run keeps creating entries in it.
function removeAbandonedRuns(root) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const directory = path.join(root, name);
    let pid;
    let modified;
    try {
      pid = Number(readFileSync(path.join(directory, OWNER_FILE), 'utf8'));
      modified = statSync(directory).mtimeMs;
    } catch {
      continue;
    }
    if (Number.isSafeInteger(pid) && pid > 0 && !processIsAlive(pid) && Date.now() - modified > ABANDONED_AFTER_MS) remove(directory);
  }
}

const root = os.tmpdir();
removeAbandonedRuns(root);
const directory = mkdtempSync(path.join(root, PREFIX));
writeFileSync(path.join(directory, OWNER_FILE), String(process.pid));

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
});
// Staying alive until the tests stop is what lets the directory be removed after Ctrl+C.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const exitCode = await new Promise(resolve => {
  child.once('error', error => {
    console.error(error.message);
    resolve(1);
  });
  child.once('close', (code, signal) => resolve(signal || code === null ? 1 : code));
});
remove(directory);
process.exit(exitCode);
