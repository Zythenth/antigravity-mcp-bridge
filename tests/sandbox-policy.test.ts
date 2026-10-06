import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeSandboxPolicy, resolveSandboxSelection, sandboxPolicyDigest, sandboxPolicySchema, validateSandboxGrant } from '../src/sandbox-policy.js';
import { StateStore } from '../src/state-store.js';

interface Fixture {
  root: string;
  readRoot: string;
  readFile: string;
  writeRoot: string;
  writeFile: string;
  source: string;
  state: string;
}

async function fixture<T>(run: (paths: Fixture) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sandbox-policy-test-')));
  const paths = {
    root,
    readRoot: path.join(root, 'read'),
    readFile: path.join(root, 'read', 'nested', 'input.txt'),
    writeRoot: path.join(root, 'write'),
    writeFile: path.join(root, 'write', 'nested', 'output.txt'),
    source: path.join(root, 'source'),
    state: path.join(root, 'state'),
  };
  try {
    await Promise.all([mkdir(path.dirname(paths.readFile), { recursive: true }), mkdir(path.dirname(paths.writeFile), { recursive: true }), mkdir(paths.source), mkdir(paths.state)]);
    await Promise.all([writeFile(paths.readFile, 'input'), writeFile(paths.writeFile, 'output'), writeFile(path.join(paths.source, 'source.txt'), 'source')]);
    return await run(paths);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('normalizes a versioned policy and permits nested read and write selections', async () => {
  await fixture(async paths => {
    const policy = await normalizeSandboxPolicy({ readRoots: [paths.readRoot], writeRoots: [paths.writeRoot],
      childProcesses: false, maxOutputChars: 512 }, paths.state, []);
    assert.ok(policy.readRoots.includes(paths.readRoot));
    assert.ok(policy.readRoots.includes(paths.writeRoot), 'write roots imply read access');
    const digest = sandboxPolicyDigest(policy);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.throws(() => sandboxPolicyDigest({ ...policy, readRoots: [...policy.readRoots].reverse() }), { code: 'INVALID_SANDBOX_POLICY' });

    const selection = await resolveSandboxSelection(policy, { readPaths: [paths.readFile], writePaths: [paths.writeFile],
      childProcesses: false, maxOutputChars: 512 }, paths.source, paths.state, []);
    assert.deepEqual(selection, { readPaths: [paths.readFile, paths.writeFile].sort(), writePaths: [paths.writeFile],
      network: false, childProcesses: false, maxOutputChars: 512 });
  });
});

test('selection defaults remain within a restricted policy and escalation is denied', async () => {
  await fixture(async paths => {
    assert.deepEqual(await resolveSandboxSelection(sandboxPolicySchema.parse({}), {}, paths.source, paths.state, []), {
      readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 4000,
    });
    const policy = await normalizeSandboxPolicy({ readRoots: [paths.readRoot], childProcesses: false, maxOutputChars: 256 }, paths.state, []);
    assert.deepEqual(await resolveSandboxSelection(policy, {}, paths.source, paths.state, []), {
      readPaths: [], writePaths: [], network: false, childProcesses: false, maxOutputChars: 256,
    });
    for (const request of [{ network: true }, { childProcesses: true }, { maxOutputChars: 257 }, { writePaths: [paths.writeFile] }]) {
      await assert.rejects(resolveSandboxSelection(policy, request, paths.source, paths.state, []), { code: 'SANDBOX_PERMISSION_DENIED' });
    }
    await assert.rejects(resolveSandboxSelection(policy, { readPaths: [path.join(paths.readRoot, 'missing.txt')] }, paths.source, paths.state, []), { code: 'INVALID_SANDBOX_PATH' });
  });
});

test('protected state, source, and ancestor paths are denied before directory traversal', async () => {
  await fixture(async paths => {
    await assert.rejects(normalizeSandboxPolicy({ readRoots: [paths.root] }, paths.state, []), { code: 'SANDBOX_PATH_PROTECTED' });
    const policy = await normalizeSandboxPolicy({ readRoots: [paths.readRoot] }, paths.state, []);
    await assert.rejects(resolveSandboxSelection(policy, { readPaths: [paths.source] }, paths.source, paths.state, []), { code: 'SANDBOX_PATH_PROTECTED' });
    await assert.rejects(normalizeSandboxPolicy({ readRoots: [paths.state] }, paths.state, []), { code: 'SANDBOX_PATH_PROTECTED' });
  });
});

test('bridge scratch-named paths are protected like every other internal runner directory', async () => {
  await fixture(async paths => {
    const scratch = path.join(paths.root, 'agy-mcp-scratch-owned');
    await mkdir(scratch);
    await assert.rejects(normalizeSandboxPolicy({ readRoots: [scratch] }, paths.state, []), { code: 'SANDBOX_PATH_PROTECTED' });
  });
});

test('directory grants reject intermediate links when the filesystem permits them', async context => {
  await fixture(async paths => {
    const linkPath = path.join(paths.root, 'linked-read');
    try { await symlink(paths.readRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Directory links are unavailable on this filesystem'); return; }
      throw error;
    }
    await assert.rejects(normalizeSandboxPolicy({ readRoots: [path.join(linkPath, 'nested')] }, paths.state, []), { code: 'INVALID_SANDBOX_PATH' });
  });
});

test('directory grants reject hard-linked files when the filesystem permits them', async context => {
  await fixture(async paths => {
    const original = path.join(paths.root, 'original.txt'), alias = path.join(paths.readRoot, 'hard-link.txt');
    await writeFile(original, 'same file');
    try { await link(original, alias); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Hard links are unavailable on this filesystem'); return; }
      throw error;
    }
    await assert.rejects(validateSandboxGrant(paths.readRoot), { code: 'INVALID_SANDBOX_PATH' });
  });
});

test('directory grants use the configured copy bounds', async () => {
  await fixture(async paths => {
    await assert.rejects(normalizeSandboxPolicy({ readRoots: [paths.readRoot] }, paths.state, [], {
      maxCopyFiles: 1, maxCopyBytes: 1024,
    }), { code: 'SANDBOX_PATH_TOO_LARGE' });
  });
});

test('write roots cannot expand normalized read access beyond the path limit', async () => {
  await fixture(async paths => {
    const readRoots = Array.from({ length: 20 }, (_, index) => path.join(paths.root, 'read-' + index));
    const writeRoots = Array.from({ length: 20 }, (_, index) => path.join(paths.root, 'write-' + index));
    await Promise.all([...readRoots, ...writeRoots].map(directory => mkdir(directory)));
    await assert.rejects(normalizeSandboxPolicy({ readRoots, writeRoots }, paths.state, []), { code: 'INVALID_SANDBOX_POLICY' });
  });
});

test('path syntax rejects relative, remote, device, stream, and NUL targets', async () => {
  const invalid = ['relative', '\\\\server\\share', 'NUL', 'before\0after'];
  if (process.platform === 'win32') invalid.push('C:\\Temp\\file.txt:stream');
  else invalid.push('//remote/share');
  for (const candidate of invalid) await assert.rejects(validateSandboxGrant(candidate), { code: 'INVALID_SANDBOX_PATH' });
});

test('state storage defaults strictly, round-trips atomically, and rejects malformed or oversized policy files', async () => {
  await fixture(async paths => {
    const state = new StateStore(paths.state), other = new StateStore(paths.state);
    const defaultSnapshot = state.loadSandboxPolicy();
    assert.deepEqual(defaultSnapshot.policy, sandboxPolicySchema.parse({}));
    assert.equal(defaultSnapshot.sha256, sandboxPolicyDigest(defaultSnapshot.policy));

    const release = state.acquire('sandbox-policy');
    try {
      assert.throws(() => other.acquire('sandbox-policy'), { code: 'STATE_BUSY' });
      assert.equal(state.loadSandboxPolicy().sha256, defaultSnapshot.sha256, 'caller can perform compare-and-swap under the lock');
      const policy = sandboxPolicySchema.parse({ childProcesses: false, maxOutputChars: 256 });
      state.saveSandboxPolicy({ version: 1, policy, sha256: sandboxPolicyDigest(policy) });
    } finally { release(); }

    const saved = other.loadSandboxPolicy();
    assert.equal(saved.policy.childProcesses, false);
    assert.equal(saved.policy.maxOutputChars, 256);
    assert.deepEqual((await readdir(paths.state)).filter(name => name.endsWith('.tmp')), []);

    const policyFile = path.join(paths.state, 'sandbox-policy.json');
    await writeFile(policyFile, '{');
    assert.throws(() => state.loadSandboxPolicy(), { code: 'INVALID_STATE' });
    assert.throws(() => state.saveSandboxPolicy(saved), { code: 'INVALID_STATE' });
    await writeFile(policyFile, Buffer.alloc(300_000));
    assert.throws(() => state.loadSandboxPolicy(), { code: 'INVALID_STATE' });
  });
});

test('state storage rejects a linked sandbox policy file when the filesystem permits it', async context => {
  await fixture(async paths => {
    const state = new StateStore(paths.state), policyFile = path.join(paths.state, 'sandbox-policy.json');
    const target = path.join(paths.root, 'other-policy.json');
    await writeFile(target, JSON.stringify(state.loadSandboxPolicy()));
    try { await symlink(target, policyFile, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('File links are unavailable on this filesystem'); return; }
      throw error;
    }
    assert.throws(() => state.loadSandboxPolicy(), { code: 'INVALID_STATE' });
  });
});
