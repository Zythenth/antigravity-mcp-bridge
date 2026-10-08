import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { executeWindowsTest } from '../src/windows-executor.js';
import { windowsHelperSource } from '../src/windows-helper-source.js';

const settings = { timeoutSeconds: 20, maxRuntimeBytes: 256 * 1024 * 1024, maxRuntimeFiles: 10_000 };

async function ownedTemporaryDirectory(directory: string, prefix: string): Promise<string> {
  const temporary = await realpath(os.tmpdir());
  const canonical = await realpath(directory);
  assert.equal(path.dirname(canonical), temporary);
  assert.ok(path.basename(canonical).startsWith(prefix));
  return canonical;
}

async function fixture<T>(run: (copy: string, state: string, sibling: string) => Promise<T>): Promise<T> {
  const temporary = await realpath(os.tmpdir());
  const copy = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-copy-')));
  const state = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-alias-state-')));
  const sibling = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-alias-sibling-')));
  try { return await run(copy, state, sibling); }
  finally {
    for (const [directory, prefix] of [[copy, 'agy-mcp-copy-'], [state, 'agy-mcp-alias-state-'], [sibling, 'agy-mcp-alias-sibling-']] as const) {
      await rm(await ownedTemporaryDirectory(directory, prefix), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

function lineJson(output: string): Record<string, unknown> {
  const line = output.trim().split(/\r?\n/).at(-1);
  assert.ok(line);
  return JSON.parse(line) as Record<string, unknown>;
}

type ProcessResult = { code: number | null; output: string };
type AliasHarness = { directory: string; runner: string; executable: string };
let harnessPromise: Promise<AliasHarness> | undefined;

async function run(executable: string, args: string[]): Promise<ProcessResult> {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, output };
}

async function aliasHarness(): Promise<AliasHarness> {
  harnessPromise ??= (async () => {
    const temporary = await realpath(os.tmpdir());
    const directory = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-alias-harness-')));
    const runner = path.join(directory, 'runner.cs'), library = path.join(directory, 'runner.dll'), source = path.join(directory, 'harness.cs'), executable = path.join(directory, 'harness.exe');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    try {
      await writeFile(runner, windowsHelperSource, { flag: 'wx' });
      await writeFile(source, await readFile(path.resolve('tests/windows-alias-harness.cs'), 'utf8'), { flag: 'wx' });
      for (const args of [
        ['/nologo', '/target:library', '/platform:x64', '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + library, runner],
        ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/out:' + executable, source],
      ]) {
        const result = await run(compiler, args);
        assert.equal(result.code, 0, result.output);
      }
      return { directory, runner: library, executable };
    } catch (error) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      throw error;
    }
  })();
  return harnessPromise;
}

after(async () => {
  const harness = await harnessPromise;
  if (harness) await rm(await ownedTemporaryDirectory(harness.directory, 'agy-mcp-alias-harness-'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function harnessAction(action: string, name?: string): Promise<string> {
  const harness = await aliasHarness();
  const result = await run(harness.executable, [harness.runner, action, ...(name ? [name] : [])]);
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}

async function assertAliasesAbsent(result: { nonce: string; pathMappings: Array<{ kind: string; aliasRoot: string }> }): Promise<void> {
  for (const mapping of result.pathMappings) {
    assert.equal(await harnessAction('query', mapping.aliasRoot.slice(0, 2)), 'ABSENT', 'drive alias must be removed');
    const custom = 'AGY.TEST.' + result.nonce.toUpperCase() + '.' + mapping.kind.toUpperCase();
    assert.equal(await harnessAction('query', custom), 'ABSENT', 'custom alias must be removed');
  }
}

async function eventually(description: string, observe: () => Promise<boolean>, timeoutMilliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await observe()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(description);
}

test('Windows executor projects owned Node paths through three cleaned DOS aliases', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, state, sibling) => {
    const inside = path.join(copy, 'inside.txt');
    const entry = path.join(copy, 'entry.cjs');
    const siblingArgument = path.join(sibling, 'same-prefix-is-not-owned.txt');
    const relativeArgument = copy + '\\nested\\..\\inside.txt';
    const siblingPrefixArgument = copy + '-sibling\\inside.txt';
    const streamArgument = inside + ':literal';
    const driveRelativeArgument = 'Q:literal';
    const uncArgument = '\\\\server\\share\\literal';
    const deviceArgument = '\\\\?\\C:\\literal';
    const embeddedArgument = 'prefix=' + inside;
    await writeFile(inside, 'inside');
    await writeFile(path.join(copy, 'relative.cjs'), "module.exports='relative-loaded';\n");
    await writeFile(entry, "const fs=require('node:fs');if(require('./relative.cjs')!=='relative-loaded')throw Error('relative require failed');if(fs.readFileSync(process.argv[2],'utf8')!=='inside')throw Error('owned argument failed');console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n");
    const result = await executeWindowsTest({ executable: process.execPath, args: [entry, inside, siblingArgument, relativeArgument, siblingPrefixArgument, streamArgument, driveRelativeArgument, uncArgument, deviceArgument, embeddedArgument] }, copy, { ...settings, stateDirectory: state });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.aliasesDeleted, true);
    assert.equal(result.pathMappings.length, 3);
    const mappings = new Map(result.pathMappings.map(mapping => [mapping.kind, mapping]));
    const copyMapping = mappings.get('copy');
    assert.ok(copyMapping);
    assert.equal(copyMapping.physicalRoot.toLocaleLowerCase('en-US'), copy.toLocaleLowerCase('en-US'));
    assert.equal(new Set(result.pathMappings.map(mapping => mapping.aliasRoot)).size, 3);
    for (const mapping of result.pathMappings) {
      assert.match(mapping.aliasRoot, /^[D-Z]:\\$/);
      assert.equal(path.dirname(mapping.physicalRoot), await realpath(os.tmpdir()));
    }
    const receipt = lineJson(result.output);
    assert.equal(receipt.cwd, copyMapping.aliasRoot);
    assert.deepEqual(receipt.args, [copyMapping.aliasRoot + 'inside.txt', siblingArgument, relativeArgument, siblingPrefixArgument, streamArgument, driveRelativeArgument, uncArgument, deviceArgument, embeddedArgument]);
    await assertAliasesAbsent(result);
  });
});

test('Windows executor can reuse a copy after aliases are cleaned', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, state) => {
    for (const marker of ['first.txt', 'second.txt']) {
      const result = await executeWindowsTest({ executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'ok')"] }, copy, { ...settings, stateDirectory: state });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.aliasesDeleted, true);
      assert.equal(result.pathMappings.length, 3);
      assert.equal(await readFile(path.join(copy, marker), 'utf8'), 'ok');
      await assertAliasesAbsent(result);
    }
  });
});

test('Windows executor leaves no aliases after a program failure and concurrent controllers use different drives', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, state) => {
    const failed = await executeWindowsTest({ executable: process.execPath, args: ['-e', 'process.exit(19)'] }, copy, { ...settings, stateDirectory: state });
    assert.equal(failed.exitCode, 19, JSON.stringify(failed));
    await assertAliasesAbsent(failed);
  });
  const executions = Array.from({ length: 2 }, () => {
    let announce: (paths: { ready: string; release: string }) => void = () => {};
    const launched = new Promise<{ ready: string; release: string }>(resolve => { announce = resolve; });
    const result = fixture(async (copy, state) => {
      const ready = path.join(copy, 'ready.txt'), release = path.join(copy, 'release.txt');
      const script = "const fs=require('node:fs');const ready=process.argv[1],release=process.argv[2],deadline=Date.now()+10000;fs.writeFileSync(ready,'ready');const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);process.stdout.write('concurrent');process.exit(0)}if(Date.now()>deadline){clearInterval(timer);process.exit(97)}},25);";
      const execution = executeWindowsTest({ executable: process.execPath, args: ['-e', script, ready, release] }, copy, { ...settings, stateDirectory: state });
      announce({ ready, release });
      const completed = await execution;
      assert.equal(completed.exitCode, 0, JSON.stringify(completed));
      assert.equal(completed.output, 'concurrent');
      await assertAliasesAbsent(completed);
      return completed;
    });
    return { launched, result };
  });
  const paths = await Promise.all(executions.map(execution => execution.launched));
  await eventually('concurrent controllers did not both create aliases', async () => (await Promise.all(paths.map(async current => (await readFile(current.ready, 'utf8').catch(() => '')) === 'ready'))).every(Boolean));
  await Promise.all(paths.map(current => writeFile(current.release, 'release')));
  const results = await Promise.all(executions.map(execution => execution.result));
  assert.equal(new Set(results.flatMap(result => result.pathMappings.map(mapping => mapping.aliasRoot))).size, 6, 'concurrent controllers must reserve distinct drive aliases');
});

test('Windows alias host harness preserves foreign and stacked mappings and recovers bounded edge cases', { skip: process.platform !== 'win32' }, async () => {
  await harnessAction('foreign-stacked');
  await harnessAction('insufficient');
  await harnessAction('abandoned');
  await harnessAction('recovery-luid');
});
