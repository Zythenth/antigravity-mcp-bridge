import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// Named ESM imports of 'node:fs' bind at link time; dynamic import with a cache-busting
// query ensures the module links against the mocked writeFileSync export after syncBuiltinESMExports.
async function loadStateStore(): Promise<typeof import('../src/state-store.js')> {
  return await import(`../src/state-store.js?t=${randomUUID()}`);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-state-store-lock-test-'));
  return {
    directory,
    close() {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
      assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-state-store-lock-test-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('acquire recovers from transient EPERM on Windows exclusive lock creation', { skip: process.platform !== 'win32' }, async t => {
  const { directory, close } = fixture();
  const lockFile = path.join(directory, 'registry.lock');
  const originalWriteFileSync = fs.writeFileSync;
  let lockCreateAttempts = 0;
  try {
    t.mock.method(fs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
      const [target, , options] = args;
      const isExclusive = typeof options === 'object' && options !== null && 'flag' in options && options.flag === 'wx';
      if (typeof target === 'string' && path.resolve(target) === path.resolve(lockFile) && isExclusive) {
        lockCreateAttempts++;
        if (lockCreateAttempts === 1) {
          const error = new Error('EPERM: operation not permitted, open');
          Object.assign(error, { code: 'EPERM' });
          throw error;
        }
      }
      return originalWriteFileSync(...args);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();

    const { StateStore } = await loadStateStore();
    const store = new StateStore(directory);
    const release = store.acquire('registry');
    assert.equal(typeof release, 'function');
    assert.equal(fs.existsSync(lockFile), true);
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number };
    assert.equal(content.pid, process.pid);
    release();
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(lockCreateAttempts, 2);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    close();
  }
});

test('acquire throws STATE_BUSY when exclusive lock creation repeatedly yields EPERM on Windows', { skip: process.platform !== 'win32' }, async t => {
  const { directory, close } = fixture();
  const lockFile = path.join(directory, 'registry.lock');
  const originalWriteFileSync = fs.writeFileSync;
  let lockCreateAttempts = 0;
  try {
    t.mock.method(fs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
      const [target, , options] = args;
      const isExclusive = typeof options === 'object' && options !== null && 'flag' in options && options.flag === 'wx';
      if (typeof target === 'string' && path.resolve(target) === path.resolve(lockFile) && isExclusive) {
        lockCreateAttempts++;
        const error = new Error('EPERM: operation not permitted, open');
        Object.assign(error, { code: 'EPERM' });
        throw error;
      }
      return originalWriteFileSync(...args);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();

    const { StateStore } = await loadStateStore();
    const store = new StateStore(directory);
    assert.throws(() => store.acquire('registry'), { code: 'STATE_BUSY' });
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(lockCreateAttempts, 3);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    close();
  }
});
