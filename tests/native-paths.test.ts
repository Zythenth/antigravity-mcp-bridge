import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createProjectCopy, discardProjectCopy } from '../src/isolation.js';
import { prepareNativeTest, readNativeReceipt } from '../src/native-tests.js';

test('native runner accepts the Windows short alias of the same copy directory', { skip: process.platform !== 'win32' }, async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-native-path-test-'));
  let project: Awaited<ReturnType<typeof createProjectCopy>> | undefined;
  let native: Awaited<ReturnType<typeof prepareNativeTest>> | undefined;
  try {
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
    await writeFile(path.join(directory, 'source.txt'), 'original');
    project = await createProjectCopy(directory);
    assert.ok(!/[%"!\r\n]/.test(project.copyDirectory));
    const shortPath = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("' + project.copyDirectory + '") do @echo %~sI'], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
    assert.equal(shortPath.status, 0, shortPath.stderr);
    const alias = shortPath.stdout.trim();
    if (alias === project.copyDirectory) { context.skip('Filesystem does not expose an 8.3 alias'); return; }
    native = await prepareNativeTest({ ...project, copyDirectory: alias }, {
      executable: process.execPath, args: ['-e', 'process.stdout.write("alias checked")'], maxAttempts: 1, expectedSha256: 'a'.repeat(64),
    }, { timeoutSeconds: 10, maxCopyFiles: 10000, maxCopyBytes: 268435456 });
    const output = execSync(native.commandLine, { cwd: project.copyDirectory, encoding: 'utf8', shell: 'powershell.exe', windowsHide: true });
    const observed = readNativeReceipt({ state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: native.commandLine }, output } }, native);
    assert.equal(observed?.receipt.error, undefined);
    assert.equal(observed?.receipt.exitCode, 0);
    assert.equal(observed?.output, 'alias checked');
  } finally {
    await native?.cleanup();
    if (project) await discardProjectCopy(project);
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('agy-native-path-test-')) throw Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});
