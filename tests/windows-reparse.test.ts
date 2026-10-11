import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reparseInspectorSource, windowsHelperSource } from '../src/windows-helper-source.js';

test('native Windows inspectors distinguish Cloud Files from links and unknown tags', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const root = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(root, 'agy-mcp-reparse-test-')));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const inspector = path.join(directory, 'inspector.exe');
  const runner = path.join(directory, 'runner.dll');
  const harness = path.join(directory, 'harness.exe');
  try {
    for (const [name, source, target, extra] of [
      ['inspector.cs', reparseInspectorSource, inspector, []],
      ['runner.cs', windowsHelperSource, runner, ['/target:library', '/r:System.Web.Extensions.dll', '/nowarn:0649']],
      ['harness.cs', await readFile(path.resolve('tests/windows-reparse-harness.cs'), 'utf8'), harness, []],
    ] as const) {
      const file = path.join(directory, name);
      await writeFile(file, source, { flag: 'wx' });
      execFileSync(compiler, ['/nologo', '/platform:x64', ...extra, '/out:' + target, file], { windowsHide: true });
    }
    for (const [assembly, type] of [[inspector, 'ReparseInspector'], [runner, 'WindowsTestRunner']]) {
      assert.equal(execFileSync(harness, [assembly!, type!], { windowsHide: true, encoding: 'utf8' }).trim(), 'safe');
    }
    const inspect = (file: string) => spawnSync(inspector, [], {
      input: Buffer.from(file, 'utf16le').toString('base64') + '\n', encoding: 'utf8', windowsHide: true,
    });
    assert.equal(inspect(directory).status, 0);
    const junction = path.join(directory, 'junction');
    await symlink(directory, junction, 'junction');
    const rejected = inspect(path.join(junction, 'missing'));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unsafe reparse point/);
    const pinned = spawnSync(harness, [runner, 'WindowsTestRunner', junction], { encoding: 'utf8', windowsHide: true });
    assert.equal(pinned.status, 1);
    assert.match(pinned.stderr, /unsafe reparse point/);

    // In an actual Cloud Files checkout, exercise tags returned by Windows, including its ancestors.
    assert.equal(inspect(process.cwd()).status, 0);
    assert.equal(execFileSync(harness, [runner, 'WindowsTestRunner', path.resolve('package.json')], {
      encoding: 'utf8', windowsHide: true,
    }).trim(), 'safe');
  } finally {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('agy-mcp-reparse-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
