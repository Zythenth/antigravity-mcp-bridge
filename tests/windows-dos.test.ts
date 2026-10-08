import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeWindowsTest, type WindowsExecution } from '../src/windows-executor.js';

const settings = { timeoutSeconds: 30, maxRuntimeBytes: 256 * 1024 * 1024, maxRuntimeFiles: 10_000 };
const snapshotMagic = 0x44534E50;

interface DosSnapshot {
  raw: Buffer;
  ok: boolean;
  error: number;
  characters: number;
  targets: string[];
}

interface AliasPlan {
  kind: 'copy' | 'runtime' | 'scratch';
  physicalRoot: string;
  customName: string;
  drive: string;
  aliasRoot: string;
  customTarget: string;
  driveTarget: string;
}

interface ActiveLease {
  nonce: string;
  phase: string;
  aliases: AliasPlan[];
}

async function regularFile(file: string): Promise<boolean> {
  return Boolean((await stat(file).catch(() => undefined))?.isFile());
}

async function removeOwned(directory: string, temporary: string, prefix: string): Promise<void> {
  const canonical = await realpath(directory);
  assert.equal(path.dirname(canonical), temporary);
  assert.ok(path.basename(canonical).startsWith(prefix));
  await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function compileFixture(directory: string): Promise<string> {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  assert.ok(await regularFile(vswhere), 'Windows DOS namespace release gate requires vswhere.exe and the Visual C++ Build Tools');
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.ok(installation, 'Windows DOS namespace release gate requires the Visual C++ Build Tools');
  const toolset = (await readdir(path.join(installation, 'VC', 'Tools', 'MSVC'))).sort().at(-1);
  assert.ok(toolset, 'Windows DOS namespace release gate found no MSVC toolset');
  const compiler = path.join(installation, 'VC', 'Tools', 'MSVC', toolset, 'bin', 'Hostx64', 'x64', 'cl.exe');
  const developerCommand = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  assert.ok(await regularFile(compiler) && await regularFile(developerCommand), 'Windows DOS namespace release gate found incomplete MSVC Build Tools');
  const source = path.join(process.cwd(), 'tests', 'windows-dos-fixture.cpp');
  const executable = path.join(directory, 'dos-namespace-fixture.exe');
  const script = path.join(directory, 'compile-fixture.cmd');
  await writeFile(script, [
    '@echo off',
    'call "' + developerCommand + '" -no_logo -arch=amd64 -host_arch=amd64',
    'if errorlevel 1 exit /b %errorlevel%',
    '"' + compiler + '" /nologo /std:c++17 /EHsc /MT /W4 /Fo:"' + path.join(directory, 'dos-namespace-fixture.obj') + '" /Fe:"' + executable + '" "' + source + '"',
  ].join('\r\n') + '\r\n', { flag: 'wx' });
  try {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  } catch (error) {
    throw new Error('Windows DOS namespace release gate could not compile its native fixture: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    await rm(script, { force: true });
  }
  assert.ok(await regularFile(executable), 'Windows DOS namespace release gate did not produce its native fixture');
  return executable;
}

function runFixture(executable: string, args: string[]): string {
  return execFileSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

async function hostSnapshot(executable: string, directory: string, name: string | undefined): Promise<DosSnapshot> {
  const output = path.join(directory, 'host-snapshot-' + randomUUID() + '.bin');
  try {
    const receipt = runFixture(executable, ['--host-snapshot', output, name ?? '@']);
    assert.match(receipt, /host-snapshot result=1 error=0 chars=\d+/);
    const raw = await readFile(output);
    assert.ok(raw.length >= 16, 'host snapshot header is truncated');
    assert.equal(raw.readUInt32LE(0), snapshotMagic, 'host snapshot magic is invalid');
    const ok = raw.readUInt32LE(4) === 1;
    const error = raw.readUInt32LE(8);
    const characters = raw.readUInt32LE(12);
    assert.equal(raw.length, 16 + characters * 2, 'host snapshot has an invalid MULTI_SZ length');
    const targets = ok ? raw.subarray(16).toString('utf16le').split('\0').filter(Boolean) : [];
    return { raw, ok, error, characters, targets };
  } finally {
    await rm(output, { force: true });
  }
}

function hostMutate(executable: string, operation: string, name: string, target: string | undefined): void {
  const output = runFixture(executable, ['--host-mutate', operation, name, target ?? '@']);
  const receipt = new RegExp('^host-mutate operation=' + operation + ' name=' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' result=(\\d) error=(\\d+)\\r?\\n?$').exec(output);
  assert.ok(receipt, 'unexpected host mutation receipt: ' + output);
  assert.equal(receipt[1], '1', output);
  assert.equal(receipt[2], '0', output);
}

function assertExact(snapshot: DosSnapshot, target: string, description: string): void {
  assert.equal(snapshot.ok, true, description + ': QueryDosDeviceW failed with ' + snapshot.error);
  assert.deepEqual(snapshot.targets, [target], description + ': QueryDosDeviceW returned an unexpected target stack');
}

function assertAbsent(snapshot: DosSnapshot, description: string): void {
  assert.equal(snapshot.ok, false, description + ': QueryDosDeviceW unexpectedly resolved a definition');
  assert.equal(snapshot.error, 2, description + ': QueryDosDeviceW did not report ERROR_FILE_NOT_FOUND');
}

async function waitFor<T>(description: string, inspect: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await inspect();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(description + ' timed out' + (lastError ? ': ' + String(lastError) : ''));
}

async function waitForFile(file: string, description: string): Promise<void> {
  await waitFor(description, async () => (await stat(file).catch(() => undefined))?.isFile() ? true : undefined);
}

function isAliasPlan(value: unknown): value is AliasPlan {
  if (!value || typeof value !== 'object') return false;
  const alias = value as Record<string, unknown>;
  return (alias.kind === 'copy' || alias.kind === 'runtime' || alias.kind === 'scratch') &&
    ['physicalRoot', 'customName', 'drive', 'aliasRoot', 'customTarget', 'driveTarget'].every(key => typeof alias[key] === 'string');
}

function readLease(value: unknown): ActiveLease | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const lease = value as Record<string, unknown>;
  if (typeof lease.nonce !== 'string' || typeof lease.phase !== 'string' || !Array.isArray(lease.aliases) || !lease.aliases.every(isAliasPlan)) return undefined;
  return { nonce: lease.nonce, phase: lease.phase, aliases: lease.aliases };
}

async function activeLease(state: string): Promise<ActiveLease> {
  const leases = path.join(state, 'windows-lpac-leases');
  return await waitFor('active native DOS lease', async () => {
    const entries = await readdir(leases).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const parsed = readLease(JSON.parse(await readFile(path.join(leases, entry), 'utf8')));
      if (parsed?.phase === 'active') return parsed;
    }
    return undefined;
  });
}

function aliasFor(lease: ActiveLease, kind: AliasPlan['kind']): AliasPlan {
  const alias = lease.aliases.find(candidate => candidate.kind === kind);
  assert.ok(alias, 'active lease has no ' + kind + ' alias');
  return alias;
}

function assertLeasePlan(lease: ActiveLease): void {
  assert.match(lease.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(lease.aliases.length, 3);
  assert.deepEqual(new Set(lease.aliases.map(alias => alias.kind)), new Set(['copy', 'runtime', 'scratch']));
  for (const alias of lease.aliases) {
    assert.match(alias.customName, /^AGY\.TEST\.[0-9A-F-]+\.(COPY|RUNTIME|SCRATCH)$/);
    assert.match(alias.drive, /^[D-Z]:$/);
    assert.equal(alias.aliasRoot, alias.drive + '\\');
    assert.equal(alias.customTarget, rawTarget(alias.physicalRoot));
    assert.equal(alias.driveTarget, rawTarget(alias.customName));
  }
}

function rawTarget(value: string): string {
  return '\\??\\' + value;
}

async function unusedDrive(executable: string, directory: string, occupied: ReadonlySet<string>): Promise<string> {
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const candidate = letter + ':';
    if (occupied.has(candidate)) continue;
    const snapshot = await hostSnapshot(executable, directory, candidate);
    if (!snapshot.ok && snapshot.error === 2) return candidate;
  }
  throw new Error('Windows DOS namespace release gate found no unused drive letter');
}

function mutationReceipts(output: string): Map<string, { result: string; error: string }> {
  const receipts = new Map<string, { result: string; error: string }>();
  for (const match of output.matchAll(/^mutate id=([^\s]+) name=([^\s]+) result=(\d) error=(\d+)$/gm)) {
    receipts.set(match[1]!, { result: match[3]!, error: match[4]! });
  }
  return receipts;
}

function queryReceipts(output: string): Array<{ id: string; result: string; error: string }> {
  return [...output.matchAll(/^query id=([^\s]+) name=([^\s]+) result=(\d) error=(\d+) chars=(\d+)$/gm)]
    .map(match => ({ id: match[1]!, result: match[3]!, error: match[4]! }));
}

function assertLowTokenDenied(execution: WindowsExecution): void {
  assert.match(execution.output, /token app-container=1 known=1 lpac=[01] known=[01]/);
  const expectedMutations = [
    'custom-redefine', 'custom-remove-exact', 'custom-remove-prefix', 'custom-remove-null', 'custom-remove-nonexact',
    'drive-redefine', 'drive-remove-exact', 'drive-remove-prefix', 'drive-remove-null', 'drive-remove-nonexact',
    'fresh-custom-create', 'fresh-drive-create',
  ];
  const mutations = mutationReceipts(execution.output);
  assert.deepEqual([...mutations.keys()].sort(), [...expectedMutations].sort(), execution.output);
  for (const id of expectedMutations) {
    const receipt = mutations.get(id);
    assert.ok(receipt, id + ' did not call DefineDosDeviceW');
    assert.equal(receipt.result, '0', id + ' unexpectedly changed the DOS namespace:\n' + execution.output);
    assert.equal(receipt.error, '5', id + ' did not receive ERROR_ACCESS_DENIED:\n' + execution.output);
  }
  const queries = queryReceipts(execution.output);
  const expectedQueries = new Set(['full-before', 'custom-before', 'drive-before', 'full-after', 'custom-after', 'drive-after', ...expectedMutations.map(id => 'after-' + id)]);
  assert.deepEqual(new Set(queries.map(query => query.id)), expectedQueries, execution.output);
  for (const query of queries) {
    assert.equal(query.result, '0', query.id + ' unexpectedly queried the DOS namespace:\n' + execution.output);
    assert.equal(query.error, '5', query.id + ' did not receive ERROR_ACCESS_DENIED:\n' + execution.output);
  }
}

async function removeExactIfOwned(executable: string, directory: string, name: string, target: string): Promise<void> {
  for (let remaining = 0; remaining < 4; remaining++) {
    const snapshot = await hostSnapshot(executable, directory, name);
    if (!snapshot.ok || !snapshot.targets.includes(target)) return;
    hostMutate(executable, 'remove-exact', name, target);
  }
  throw new Error('trusted fixture could not remove its exact DOS definition: ' + name);
}

async function runPolicy(executable: string, copy: string, state: string, childProcesses: boolean): Promise<void> {
  const id = randomUUID();
  const ready = path.join(copy, 'dos-ready-' + id);
  const release = path.join(copy, 'dos-release-' + id);
  const complete = path.join(copy, 'dos-complete-' + id);
  const finish = path.join(copy, 'dos-finish-' + id);
  const planFile = path.join(copy, 'dos-plan-' + id);
  const running = executeWindowsTest({ executable, args: ['--low', ready, release, complete, finish, planFile] }, copy, {
    ...settings,
    stateDirectory: state,
    sandbox: { readPaths: [], writePaths: [], network: false, childProcesses, maxOutputChars: 12_000 },
  });
  let execution: WindowsExecution | undefined;
  let lease: ActiveLease | undefined;
  let freshCustomName: string | undefined;
  let freshCustomTarget: string | undefined;
  let freshDriveName: string | undefined;
  let freshDriveTarget: string | undefined;
  try {
    await waitForFile(ready, 'LPAC fixture readiness');
    lease = await activeLease(state);
    assertLeasePlan(lease);
    const copyAlias = aliasFor(lease, 'copy');
    const allNames = lease.aliases.flatMap(alias => [alias.customName, alias.drive]);
    const beforeNamespace = await hostSnapshot(executable, copy, undefined);
    assert.equal(beforeNamespace.ok, true, 'trusted host could not query the complete DOS namespace');
    const beforeMappings = (await Promise.all(lease.aliases.map(async alias => [
      [alias.customName, await hostSnapshot(executable, copy, alias.customName), alias.customTarget] as const,
      [alias.drive, await hostSnapshot(executable, copy, alias.drive), alias.driveTarget] as const,
    ]))).flat();
    for (const [name, snapshot, target] of beforeMappings) assertExact(snapshot, target, 'before low-token attempts: ' + name);
    freshCustomName = 'AGY.TEST.' + lease.nonce.toUpperCase() + '.FRESH';
    freshCustomTarget = rawTarget(copy);
    assertAbsent(await hostSnapshot(executable, copy, freshCustomName), 'fresh custom definition before low-token attempt');
    freshDriveName = await unusedDrive(executable, copy, new Set(lease.aliases.map(alias => alias.drive)));
    freshDriveTarget = rawTarget(copy);
    await writeFile(planFile, [
      'custom-name=' + copyAlias.customName,
      'custom-target=' + copyAlias.customTarget,
      'drive-name=' + copyAlias.drive,
      'drive-target=' + copyAlias.driveTarget,
      'fresh-custom-name=' + freshCustomName,
      'fresh-custom-target=' + freshCustomTarget,
      'fresh-drive-name=' + freshDriveName,
      'fresh-drive-target=' + freshDriveTarget,
    ].join('\n') + '\n', { encoding: 'utf16le', flag: 'wx' });
    await writeFile(release, 'release', { flag: 'wx' });
    await waitForFile(complete, 'LPAC DOS mutation completion');
    const afterNamespace = await hostSnapshot(executable, copy, undefined);
    assert.deepEqual(afterNamespace.raw, beforeNamespace.raw, 'the host DOS namespace changed while the low-token fixture was paused');
    const afterMappings = (await Promise.all(lease.aliases.map(async alias => [
      [alias.customName, await hostSnapshot(executable, copy, alias.customName), alias.customTarget] as const,
      [alias.drive, await hostSnapshot(executable, copy, alias.drive), alias.driveTarget] as const,
    ]))).flat();
    for (const [name, snapshot, target] of afterMappings) assertExact(snapshot, target, 'after low-token attempts: ' + name);
    assertAbsent(await hostSnapshot(executable, copy, freshCustomName), 'fresh custom definition after low-token attempt');
    assertAbsent(await hostSnapshot(executable, copy, freshDriveName), 'fresh drive definition after low-token attempt');
    await writeFile(finish, 'finish', { flag: 'wx' });
    execution = await running;
    assert.equal(execution.error, undefined, execution.output);
    assert.equal(execution.exitCode, 0, execution.output);
    assert.equal(execution.sandbox, 'windows-lpac');
    assert.equal(execution.profileDeleted, true);
    assert.equal(execution.aliasesDeleted, true);
    assertLowTokenDenied(execution);
    assert.deepEqual(new Set(execution.pathMappings.map(mapping => mapping.aliasRoot)), new Set(lease.aliases.map(alias => alias.aliasRoot)));
    for (const name of [...allNames, freshCustomName, freshDriveName]) assertAbsent(await hostSnapshot(executable, copy, name), 'after native cleanup: ' + name);
  } finally {
    await writeFile(release, 'release').catch(() => {});
    await writeFile(finish, 'finish').catch(() => {});
    if (!execution) await running.catch(() => {});
    if (lease) {
      for (const alias of lease.aliases) {
        await removeExactIfOwned(executable, copy, alias.drive, alias.driveTarget);
        await removeExactIfOwned(executable, copy, alias.customName, alias.customTarget);
      }
    }
    if (freshCustomName && freshCustomTarget) await removeExactIfOwned(executable, copy, freshCustomName, freshCustomTarget);
    if (freshDriveName && freshDriveTarget) await removeExactIfOwned(executable, copy, freshDriveName, freshDriveTarget);
  }
}

test('LPAC children cannot query or mutate the executor DOS namespace', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-dos-fixture-')));
  const copy = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-copy-')));
  const state = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-dos-state-')));
  try {
    const fixture = await compileFixture(root);
    const controlName = 'AGY.TEST.HOST.' + randomUUID().replaceAll('-', '').toUpperCase();
    const controlTarget = rawTarget(copy);
    assertAbsent(await hostSnapshot(fixture, copy, controlName), 'trusted host positive control before definition');
    try {
      hostMutate(fixture, 'create', controlName, controlTarget);
      assertExact(await hostSnapshot(fixture, copy, controlName), controlTarget, 'trusted host positive control query');
    } finally {
      await removeExactIfOwned(fixture, copy, controlName, controlTarget);
      assertAbsent(await hostSnapshot(fixture, copy, controlName), 'trusted host positive control cleanup');
    }
    await runPolicy(fixture, copy, state, true);
    await runPolicy(fixture, copy, state, false);
  } finally {
    await removeOwned(state, temporary, 'agy-mcp-dos-state-');
    await removeOwned(copy, temporary, 'agy-mcp-copy-');
    await removeOwned(root, temporary, 'agy-mcp-dos-fixture-');
  }
});
