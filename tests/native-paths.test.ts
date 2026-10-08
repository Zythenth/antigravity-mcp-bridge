import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createProjectCopy, discardProjectCopy, fingerprintProjectCopy } from '../src/isolation.js';
import { prepareNativeTest, readNativeReceipt, type NativeTestRequest, type WindowsNativeTestRequest } from '../src/native-tests.js';

const legacyNativeRequest: NativeTestRequest = {
  executable: process.execPath, args: ['-e', 'process.exit(0)'], maxAttempts: 1, expectedSha256: 'a'.repeat(64),
};
const windowsNativeRequest: WindowsNativeTestRequest = {
  ...legacyNativeRequest, backend: 'windows-lpac', policySha256: 'b'.repeat(64),
  sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: false, maxOutputChars: 256 },
};

test('legacy agy requests remain distinct from frozen Windows requests', () => {
  assert.equal('backend' in legacyNativeRequest, false);
  assert.equal(windowsNativeRequest.backend, 'windows-lpac');
  assert.equal(windowsNativeRequest.sandbox.maxOutputChars, 256);
});

test('native runner works when the ambient temp directory is unavailable and keeps snapshot files out of the fingerprint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-native-temp-test-'));
  let project: Awaited<ReturnType<typeof createProjectCopy>> | undefined;
  let native: Awaited<ReturnType<typeof prepareNativeTest>> | undefined;
  try {
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
    await writeFile(path.join(directory, 'source.txt'), 'original');
    project = await createProjectCopy(directory);
    native = await prepareNativeTest(project, { executable: process.execPath,
      args: ['-e', 'process.stdout.write(require("node:fs").readFileSync("source.txt","utf8"))'],
      maxAttempts: 1, expectedSha256: 'a'.repeat(64),
    }, { timeoutSeconds: 10, maxCopyFiles: 10000, maxCopyBytes: 268435456 });
    const unavailable = path.join(directory, 'missing', 'temp');
    const runner = (await readdir(project.copyDirectory)).find(file => file.endsWith('.cjs'));
    assert.ok(runner);
    const output = execFileSync(process.execPath, [path.join(project.copyDirectory, runner)], { cwd: project.copyDirectory, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TEMP: unavailable, TMP: unavailable, TMPDIR: unavailable } });
    const observed = readNativeReceipt({ state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { parameters: { CommandLine: native.commandLine }, output } }, native);
    assert.equal(observed?.receipt.error, undefined);
    assert.equal(observed?.receipt.exitCode, 0);
    assert.equal(observed?.output, 'original');
    assert.equal(observed?.receipt.beforeSha256, observed?.receipt.afterSha256);
    assert.equal(observed?.receipt.afterSha256, await fingerprintProjectCopy(project));
    assert.ok(!(await readdir(project.copyDirectory)).some(file => file.startsWith('.agy-test-snapshot-')));
  } finally {
    await native?.cleanup();
    if (project) await discardProjectCopy(project);
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('agy-native-temp-test-')) throw Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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
