import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { preauthorizedIntegrationRoots, integrationPreauthorized } from '../src/integration-policy.js';

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
