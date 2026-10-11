import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { preauthorizedIntegrationRoots, integrationPreauthorized } from '../src/integration-policy.js';
import { StateStore } from '../src/state-store.js';

test('preauthorization is explicit, canonical, exact and excludes descendant projects', () => {
  assert.deepEqual(preauthorizedIntegrationRoots(), []);
  const root = realpathSync.native(process.cwd());
  const roots = preauthorizedIntegrationRoots(JSON.stringify([root, root]));
  assert.equal(roots.length, 1);
  assert.equal(integrationPreauthorized(root, roots), true);
  assert.equal(integrationPreauthorized(path.join(root, 'nested-project'), roots), false);
  assert.equal(integrationPreauthorized(root + '-sibling', roots), false);
  assert.throws(() => preauthorizedIntegrationRoots('true'));
  assert.throws(() => preauthorizedIntegrationRoots('["relative"]'));
  assert.throws(() => preauthorizedIntegrationRoots(JSON.stringify([path.parse(root).root])));
  assert.throws(() => preauthorizedIntegrationRoots(JSON.stringify(Array(21).fill(root))));
});


test('Windows short aliases resolve to the same project identity as asynchronous task validation', { skip: process.platform !== 'win32' }, async t => {
  const alias = path.join(path.parse(process.env.ProgramFiles ?? process.cwd()).root, 'PROGRA~1');
  if (!existsSync(alias)) return t.skip('This Windows volume has no Program Files short alias');
  const canonical = await realpath(alias);
  const roots = preauthorizedIntegrationRoots(JSON.stringify([alias, canonical]));
  assert.deepEqual(roots, [canonical.toLowerCase()]);
  assert.equal(integrationPreauthorized(canonical, roots), true);
  assert.equal(integrationPreauthorized(path.join(canonical, 'different-project'), roots), false);
});

test('remembered roots persist exactly, merge under a lock and can be revoked locally', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-integration-approval-'));
  try {
    const first = path.join(directory, 'first'), second = path.join(directory, 'second');
    mkdirSync(first); mkdirSync(second);
    const state = new StateStore(path.join(directory, 'state'));
    const other = new StateStore(path.join(directory, 'state'));
    assert.deepEqual(state.loadIntegrationRoots(), []);
    state.rememberIntegrationRoot(first);
    state.rememberIntegrationRoot(first);
    const release = state.acquire('integration-approvals');
    try { assert.throws(() => other.rememberIntegrationRoot(second), { code: 'STATE_BUSY' }); }
    finally { release(); }
    other.rememberIntegrationRoot(second);
    const roots = preauthorizedIntegrationRoots(JSON.stringify([first, second]));
    assert.deepEqual(new StateStore(path.join(directory, 'state')).loadIntegrationRoots(), roots);
    assert.equal(integrationPreauthorized(path.join(first, 'nested'), roots), false);
    assert.equal(integrationPreauthorized(first + '-sibling', roots), false);
    unlinkSync(path.join(directory, 'state', 'integration-approvals.json'));
    assert.deepEqual(state.loadIntegrationRoots(), []);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agy-integration-approval-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('remembered roots reject corrupt, oversized, noncanonical and linked state without replacement', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-integration-approval-'));
  try {
    const state = new StateStore(directory);
    const file = path.join(directory, 'integration-approvals.json');
    const root = preauthorizedIntegrationRoots(JSON.stringify([directory]))[0]!;
    for (const contents of ['{', 'x'.repeat(128 * 1024 + 1),
      ...[
        { version: 1, roots: ['relative'] }, { version: 1, roots: [path.parse(root).root] },
        { version: 1, roots: [root + path.sep + '..'] }, { version: 1, roots: Array(21).fill(root) },
        { version: 1, roots: [root], extra: true }, { version: 2, roots: [root] },
      ].map(value => JSON.stringify(value))]) {
      writeFileSync(file, contents);
      assert.throws(() => state.loadIntegrationRoots(), { code: 'INVALID_STATE' });
      assert.throws(() => state.rememberIntegrationRoot(directory), { code: 'INVALID_STATE' });
      assert.equal(readFileSync(file, 'utf8'), contents);
    }
    unlinkSync(file);
    const outside = path.join(directory, 'other.json');
    const valid = JSON.stringify({ version: 1, roots: [root] });
    writeFileSync(outside, valid);
    linkSync(outside, file);
    assert.throws(() => state.loadIntegrationRoots(), { code: 'INVALID_STATE' });
    assert.throws(() => state.rememberIntegrationRoot(directory), { code: 'INVALID_STATE' });
    assert.equal(readFileSync(outside, 'utf8'), valid);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agy-integration-approval-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
