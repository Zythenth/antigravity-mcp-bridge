import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { windowsHelperSource } from '../src/windows-helper-source.js';

test('native Windows Null device helper enforces bounded least-privilege ACL transitions and recovery', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async () => {
  const root = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(root, 'agy-mcp-null-test-')));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const runner = path.join(directory, 'runner.dll');
  const harness = path.join(directory, 'harness.exe');

  try {
    const runnerSource = windowsHelperSource || await readFile(path.resolve('native/windows-test-runner.cs'), 'utf8');
    const harnessSource = await readFile(path.resolve('tests/windows-null-harness.cs'), 'utf8');

    for (const [name, source, target, extra] of [
      ['runner.cs', runnerSource, runner, ['/target:library', '/r:System.Web.Extensions.dll', '/nowarn:0649']],
      ['harness.cs', harnessSource, harness, ['/r:System.Web.Extensions.dll']],
    ] as const) {
      const file = path.join(directory, name);
      await writeFile(file, source, { flag: 'wx' });
      execFileSync(compiler, ['/nologo', '/platform:x64', ...extra, '/out:' + target, file], { windowsHide: true, stdio: 'pipe', timeout: 60000, maxBuffer: 65536 });
    }

    const testCases: readonly [string, string][] = [
      ['test-no-op-stock-acl', 'pass:no-op-stock-acl'],
      ['test-missing-stock-acl', 'pass:missing-stock-acl'],
      ['test-least-rights', 'pass:least-rights'],
      ['test-foreign-and-deny-preservation', 'pass:foreign-and-deny-preservation'],
      ['test-duplicate-and-unexpected-owned-ace', 'pass:duplicate-and-unexpected-owned-ace'],
      ['test-interrupted-pending-grant-and-recovery', 'pass:interrupted-pending-grant-and-recovery'],
      ['test-distinct-sid-transforms', 'pass:distinct-sid-transforms'],
      ['test-concurrent-distinct-sids', 'pass:concurrent-distinct-sids'],
      ['test-absent-null-grant', 'pass:absent-null-grant'],
      ['test-job-empty-wait', 'pass:job-empty-wait'],
      ['test-private-kernel-handle', 'pass:private-kernel-handle'],
      ['test-null-mutex-gate', 'pass:null-mutex-gate'],
      ['test-lease-validation', 'pass:lease-validation'],
    ];

    for (const [testName, expected] of testCases) {
      const output = execFileSync(harness, [runner, testName], { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000, maxBuffer: 65536 }).trim();
      assert.equal(output, expected, `Test ${testName} failed with output: ${output}`);
    }
  } finally {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('agy-mcp-null-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('native Windows cleanup reconciles a post-write validation failure using a private file fixture', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async () => {
  const temporary = await realpath(os.tmpdir());
  const roots: Array<{ directory: string; prefix: string }> = [];
  const create = async (prefix: string) => {
    const directory = await realpath(await mkdtemp(path.join(temporary, prefix)));
    roots.push({ directory, prefix });
    return directory;
  };
  try {
    const fixture = await create('agy-mcp-null-fault-');
    const copy = await create('agy-mcp-copy-');
    const runtime = await create('agy-mcp-runtime-');
    const scratch = await create('agy-mcp-scratch-');
    const state = path.join(fixture, 'state');
    const target = path.join(fixture, 'null-control.txt');
    await mkdir(state);
    await writeFile(target, 'synthetic null control');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const runOptions = { windowsHide: true, encoding: 'utf8' as const, stdio: 'pipe' as const, timeout: 60000, maxBuffer: 65536 };
    const compile = async (name: string, source: string, kind: 'library' | 'exe') => {
      const file = path.join(fixture, name + '.cs');
      const output = path.join(fixture, name + (kind === 'library' ? '.dll' : '.exe'));
      await writeFile(file, source, { flag: 'wx' });
      execFileSync(compiler, ['/nologo', '/platform:x64', '/target:' + kind, '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + output, file], runOptions);
      return output;
    };
    const library = await compile('runner', windowsHelperSource, 'library');
    const harness = await compile('harness', await readFile(path.resolve('tests/windows-null-harness.cs'), 'utf8'), 'exe');
    const before = execFileSync(harness, [library, 'prepare-private-file', target], runOptions).trim();
    assert.match(before, /^D:/);

    // Instrument only the compiled test variant: the system Null path and production source stay unchanged.
    const declaration = /^    const string NullDeviceKernelPath = .*;$/gm;
    assert.equal([...windowsHelperSource.matchAll(declaration)].length, 1);
    let variant = windowsHelperSource.replace(declaration, '    const string NullDeviceKernelPath = ' + JSON.stringify(target) + ';');
    const applyStart = variant.indexOf('    internal static void ApplyKernelObjectGrant(');
    const applyEnd = variant.indexOf('    internal static bool RemoveKernelObjectGrant(', applyStart);
    assert.ok(applyStart > 0 && applyEnd > applyStart);
    const apply = variant.slice(applyStart, applyEnd);
    const write = '        WriteKernelDacl(handle, toModify);';
    assert.equal(apply.split(write).length, 2);
    variant = variant.slice(0, applyStart) + apply.replace(write, write + '\n        throw new Exception("synthetic post-write validation failure");') + variant.slice(applyEnd);
    const executable = await compile('fault-runner', variant, 'exe');
    const staged = path.join(runtime, 'whoami.exe');
    await copyFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), staged);
    const nonce = randomUUID();
    const request = path.join(fixture, 'request.json');
    await writeFile(request, JSON.stringify({
      action: 'write', nonce, profile: 'agy.test.' + nonce.replaceAll('-', ''), cwd: copy, runtime, scratch,
      executable: staged, args: [], timeoutSeconds: 15, maxFiles: 10000, maxOutputChars: 4000,
      network: false, childProcesses: false, stateDirectory: state, grants: [],
      environment: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', GIT_EXEC_PATH: runtime },
    }));
    let receipt: { error?: string; profileDeleted?: boolean; aliasesDeleted?: boolean; pid?: number } | undefined;
    try { execFileSync(executable, [request], runOptions); }
    catch (error) {
      const result = error as { status?: number; stdout?: string };
      assert.equal(result.status, 1);
      receipt = JSON.parse(result.stdout || '') as typeof receipt;
    }
    assert.ok(receipt, 'the controller must report the injected failure');
    assert.equal(receipt.error, 'synthetic post-write validation failure');
    assert.equal(receipt.pid, undefined, 'no untrusted command starts after the grant failure');
    assert.equal(receipt.profileDeleted, true);
    assert.equal(receipt.aliasesDeleted, true);
    assert.equal(execFileSync(harness, [library, 'read-private-file', target], runOptions).trim(), before,
      'the actual native ACL write must be reconciled by controller cleanup');
    assert.equal(await readFile(target, 'utf8'), 'synthetic null control');
    assert.deepEqual((await readdir(state, { recursive: true })).filter(file => file.endsWith('.json')), []);
  } finally {
    for (const { directory, prefix } of roots.reverse()) {
      assert.equal(path.dirname(await realpath(directory)), temporary);
      assert.ok(path.basename(directory).startsWith(prefix));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
