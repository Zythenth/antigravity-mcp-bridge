import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { executeWindowsTest } from '../src/windows-executor.js';

const settings = { timeoutSeconds: 20, maxRuntimeBytes: 256 * 1024 * 1024, maxRuntimeFiles: 10000 };

async function temporary<T>(run: (copy: string, state: string, outside: string) => Promise<T>): Promise<T> {
  const temp = await realpath(os.tmpdir());
  const copy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
  const state = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-state-')));
  const outside = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-permissions-')));
  try { return await run(copy, state, outside); }
  finally { for (const directory of [copy, state, outside]) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function regularFile(file: string): Promise<boolean> {
  return Boolean((await stat(file).catch(() => undefined))?.isFile());
}

async function compileChildFixture(t: TestContext, directory: string): Promise<string | undefined> {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!await regularFile(vswhere)) { t.skip('Visual C++ compiler unavailable: vswhere.exe is absent'); return undefined; }
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!installation) { t.skip('Visual C++ compiler unavailable: vswhere found no C++ Build Tools installation'); return undefined; }
  const toolset = (await readdir(path.join(installation, 'VC', 'Tools', 'MSVC'))).sort().at(-1);
  if (!toolset) { t.skip('Visual C++ compiler unavailable: no MSVC toolset is installed'); return undefined; }
  const compiler = path.join(installation, 'VC', 'Tools', 'MSVC', toolset, 'bin', 'Hostx64', 'x64', 'cl.exe');
  const developerCommand = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  if (!await regularFile(compiler) || !await regularFile(developerCommand)) { t.skip('Visual C++ compiler unavailable: MSVC command files are incomplete'); return undefined; }
  const source = path.join(process.cwd(), 'tests', 'windows-child-fixture.cpp');
  const executable = path.join(directory, 'child-policy-fixture.exe');
  const script = path.join(directory, 'compile-fixture.cmd');
  await writeFile(script, [
    '@echo off',
    'call "' + developerCommand + '" -no_logo -arch=amd64 -host_arch=amd64',
    'if errorlevel 1 exit /b %errorlevel%',
    '"' + compiler + '" /nologo /std:c++17 /EHsc /MT /W4 /Fo:"' + path.join(directory, 'child-policy-fixture.obj') + '" /Fe:"' + executable + '" "' + source + '"',
  ].join('\r\n') + '\r\n', { flag: 'wx' });
  try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', script], { windowsHide: true, encoding: 'utf8' }); }
  finally { await rm(script, { force: true }); }
  return executable;
}

function isWmiAccessDenied(value: string): boolean {
  return value === '80070005' || value === '80041003';
}

function assertWmiBrokerDenied(output: string): void {
  const initialize = /wmi-com-initialize hresult=0x([0-9A-F]{8})/.exec(output);
  assert.ok(initialize, 'WMI path did not call CoInitializeEx:\n' + output);
  if (isWmiAccessDenied(initialize[1]!)) return;
  assert.equal(initialize[1], '00000000', 'WMI COM initialization failed without an access denial:\n' + output);
  const connect = /wmi-connect hresult=0x([0-9A-F]{8})/.exec(output);
  assert.ok(connect, 'WMI setup did not reach ConnectServer:\n' + output);
  if (isWmiAccessDenied(connect[1]!)) return;
  assert.equal(connect[1], '00000000', 'WMI connection failed without an access denial:\n' + output);
  const execute = /wmi-exec hresult=0x([0-9A-F]{8})/.exec(output);
  assert.ok(execute, 'WMI connected without issuing Win32_Process.Create:\n' + output);
  if (isWmiAccessDenied(execute[1]!)) return;
  assert.equal(execute[1], '00000000', 'WMI Create request failed without an access denial:\n' + output);
  const returnValue = /wmi-return-value=(\d+) present=1/.exec(output);
  assert.ok(returnValue, 'WMI Create did not return a provider status:\n' + output);
  assert.ok(returnValue[1] === '2' || returnValue[1] === '3', 'WMI Create did not report access denial or insufficient privilege:\n' + output);
}

function assertShellHasNoVerifiedProcess(output: string, receipts: string): void {
  assert.match(output, /shell-process-handle=0 process-id=0/, receipts);
  const shell = /shell-execute result=(\d+) error=(\d+)/.exec(output);
  assert.ok(shell, receipts);
  assert.ok((shell[1] === '0' && shell[2] === '5') || (shell[1] === '1' && shell[2] === '0'), receipts);
}

interface BrokerEffects {
  wmiInside: string | undefined;
  wmiOutside: string | undefined;
  shellInside: string | undefined;
  shellOutside: string | undefined;
}

async function optionalMarker(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function brokerEffects(inside: string, outside: string): Promise<BrokerEffects> {
  const markers = await Promise.all([
    optionalMarker(inside + '.wmi'), optionalMarker(outside + '.wmi'),
    optionalMarker(inside + '.shell'), optionalMarker(outside + '.shell'),
  ]);
  return { wmiInside: markers[0], wmiOutside: markers[1], shellInside: markers[2], shellOutside: markers[3] };
}

test('LPAC child policy starts a native main and denies its child creation', { skip: process.platform !== 'win32' }, async t => {
  await temporary(async (copy, state) => {
    const fixture = await compileChildFixture(t, copy);
    if (!fixture) return;
    const base = path.join(copy, 'native-child-marker');
    const allowed = await executeWindowsTest({ executable: fixture, args: [base] }, copy, { ...settings, stateDirectory: state,
      sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 4000 } });
    assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
    assert.match(allowed.output, /main-started/);
    assert.match(allowed.output, /attempt=0 created=1/);
    assert.match(allowed.output, /attempt=1 created=0/);
    assert.equal(await readFile(base + '.normal', 'utf8'), 'child');
    await rm(base + '.normal');
    await assert.rejects(readFile(base + '.breakaway'), { code: 'ENOENT' });
    const denied = await executeWindowsTest({ executable: fixture, args: [base] }, copy, { ...settings, stateDirectory: state,
      sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: false, maxOutputChars: 4000 } });
    assert.equal(denied.exitCode, 0, JSON.stringify(denied));
    assert.match(denied.output, /main-started/);
    assert.match(denied.output, /attempt=0 created=0/);
    assert.match(denied.output, /attempt=1 created=0/);
    assert.match(denied.output, /continue-after-attempt/);
    await assert.rejects(readFile(base + '.normal'), { code: 'ENOENT' });
    await assert.rejects(readFile(base + '.breakaway'), { code: 'ENOENT' });
  });
});

test('LPAC observes no WMI or shell broker child effect outside its job', { skip: process.platform !== 'win32' }, async t => {
  await temporary(async (copy, state, outside) => {
    const fixture = await compileChildFixture(t, copy);
    if (!fixture) return;
    const baselineInside = path.join(copy, 'broker-baseline-inside');
    const baselineOutside = path.join(outside, 'broker-baseline-outside');
    const baselineOutput = execFileSync(fixture, ['--broker', baselineInside, baselineOutside], { encoding: 'utf8', windowsHide: true });
    const baselineEffects = await brokerEffects(baselineInside, baselineOutside);
    assert.match(baselineOutput, /shell-execute result=1 error=0/);
    assert.match(baselineEffects.shellInside || '', /app-container=0 app-container-query=1/);
    assert.match(baselineEffects.shellInside || '', /outside-created=1 outside-error=0/);
    assert.equal(baselineEffects.shellOutside, 'outside\n');

    const allowedInside = path.join(copy, 'broker-allowed-inside');
    const allowedOutside = path.join(outside, 'broker-allowed-outside');
    const allowed = await executeWindowsTest({ executable: fixture, args: ['--broker', allowedInside, allowedOutside] }, copy, { ...settings, stateDirectory: state,
      sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 4000 } });
    const allowedEffects = await brokerEffects(allowedInside, allowedOutside);
    assert.equal(allowed.exitCode, 0, JSON.stringify({ allowed, allowedEffects }));

    const deniedInside = path.join(copy, 'broker-denied-inside');
    const deniedOutside = path.join(outside, 'broker-denied-outside');
    const denied = await executeWindowsTest({ executable: fixture, args: ['--broker', deniedInside, deniedOutside] }, copy, { ...settings, stateDirectory: state,
      sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: false, maxOutputChars: 4000 } });
    const deniedEffects = await brokerEffects(deniedInside, deniedOutside);
    const receipts = JSON.stringify({ baseline: { output: baselineOutput, effects: baselineEffects }, allowed: { output: allowed.output, effects: allowedEffects }, denied: { output: denied.output, effects: deniedEffects } });
    assert.equal(deniedEffects.wmiInside, undefined, receipts);
    assert.equal(deniedEffects.wmiOutside, undefined, receipts);
    assert.equal(deniedEffects.shellInside, undefined, receipts);
    assert.equal(deniedEffects.shellOutside, undefined, receipts);
    assert.doesNotMatch(denied.output, /wmi-process-id=[1-9]\d* present=1/, receipts);
    assertShellHasNoVerifiedProcess(denied.output, receipts);
    assert.equal(denied.exitCode, 0, receipts);
    assert.match(denied.output, /main-started/);
    assertWmiBrokerDenied(denied.output);
    assert.match(denied.output, /continue-after-attempt/);
  });
});

test('LPAC stages and runs npm.cmd version and lifecycle scripts', { skip: process.platform !== 'win32' }, async () => {
  await temporary(async (copy, state) => {
    await writeFile(path.join(copy, 'test.cjs'), "require('node:fs').writeFileSync('npm-marker.txt', 'ok');\n");
    await writeFile(path.join(copy, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test.cjs' } }));
    const version = await executeWindowsTest({ executable: 'npm.cmd', args: ['--version'] }, copy, { ...settings, stateDirectory: state });
    assert.equal(version.exitCode, 0, JSON.stringify(version));
    assert.match(version.output, /\d+\.\d+\.\d+/);
    const lifecycle = await executeWindowsTest({ executable: 'npm.cmd', args: ['test'] }, copy, { ...settings, stateDirectory: state });
    assert.equal(lifecycle.exitCode, 0, JSON.stringify(lifecycle));
    assert.equal(await readFile(path.join(copy, 'npm-marker.txt'), 'utf8'), 'ok');
  });
});
