import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageWindowsCommand } from '../src/windows-runtime.js';

const limits = { maxBytes: 256 * 1024 * 1024, maxFiles: 10_000 };

async function runtimeFixture<T>(run: (runtime: string, outside: string) => Promise<T>): Promise<T> {
  const temp = await realpath(os.tmpdir());
  const runtime = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-test-')));
  const outside = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-private-')));
  try {
    return await run(runtime, outside);
  } finally {
    for (const [directory, prefix] of [[runtime, 'agy-mcp-runtime-test-'], [outside, 'agy-mcp-runtime-private-']] as const) {
      assert.equal(path.dirname(directory), temp);
      assert.ok(path.basename(directory).startsWith(prefix));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

test('Windows runtime stages the installed npm layout without interpreting its cmd wrapper', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const userConfig = path.join(outside, '.npmrc');
    const original = process.env.NPM_CONFIG_USERCONFIG;
    await writeFile(userConfig, '//registry.example.invalid/:_authToken=private-marker\n');
    process.env.NPM_CONFIG_USERCONFIG = userConfig;
    try {
      const args = ['--version', 'literal & | < > ^ ( ) % ! " value'];
      const staged = await stageWindowsCommand({ executable: 'npm.cmd', args }, runtime, limits);
      assert.equal(path.basename(staged.executable).toLowerCase(), 'node.exe');
      assert.equal((await readFile(staged.executable)).subarray(0, 2).toString('ascii'), 'MZ');
      assert.equal(staged.args[0], path.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      assert.deepEqual(staged.args.slice(1), args);
      assert.deepEqual(staged.pathEntries, [runtime]);
      assert.equal(staged.comspec, path.join(runtime, 'system32', 'cmd.exe'));
      assert.equal((await readFile(staged.comspec!)).subarray(0, 2).toString('ascii'), 'MZ');
      const manifest = JSON.parse(await readFile(path.join(runtime, 'node_modules', 'npm', 'package.json'), 'utf8')) as { name: string; bin: { npm: string } };
      assert.equal(manifest.name, 'npm');
      assert.equal(manifest.bin.npm, 'bin/npm-cli.js');
      await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'docs')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'man')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(runtime, 'npm.cmd')), { code: 'ENOENT' });
      const sourcePolicy = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'make-fetch-happen', 'lib', 'cache', 'policy.js');
      const stagedPolicy = path.join(runtime, 'node_modules', 'npm', 'node_modules', 'make-fetch-happen', 'lib', 'cache', 'policy.js');
      assert.deepEqual(await readFile(stagedPolicy), await readFile(sourcePolicy));
      execFileSync(staged.executable, ['-e', 'require(process.argv[1])', stagedPolicy], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      const bundledConfig = await readFile(path.join(runtime, 'node_modules', 'npm', 'npmrc'), 'utf8');
      assert.doesNotMatch(bundledConfig, /private-marker/u);
    } finally {
      if (original === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
      else process.env.NPM_CONFIG_USERCONFIG = original;
    }
  });
});

test('Windows runtime preserves dependency cache source while omitting top-level npm cache and credentials', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const node = path.join(outside, 'node.exe');
    const npm = path.join(outside, 'npm.cmd');
    const npmRoot = path.join(outside, 'node_modules', 'npm');
    const dependencyPolicy = path.join(npmRoot, 'node_modules', 'make-fetch-happen', 'lib', 'cache', 'policy.js');
    await copyFile(process.execPath, node);
    await writeFile(npm, '@echo off\r\nnode_modules\\npm\\bin\\npm-cli.js\r\n');
    await mkdir(path.dirname(dependencyPolicy), { recursive: true });
    await mkdir(path.join(npmRoot, 'bin'), { recursive: true });
    await mkdir(path.join(npmRoot, 'cache'), { recursive: true });
    await writeFile(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
    await writeFile(path.join(npmRoot, 'bin', 'npm-cli.js'), '');
    await writeFile(path.join(npmRoot, 'cache', 'payload.txt'), 'omit-top-level-cache');
    await writeFile(dependencyPolicy, 'module.exports = "required dependency source";\n');
    for (const file of ['.netrc', 'credentials', 'credentials.json', 'nested', 'npmrc']) {
      const target = path.join(npmRoot, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'omit-credential');
    }
    await stageWindowsCommand({ executable: npm, args: [] }, runtime, limits);
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'cache')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', '.netrc')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'credentials')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'credentials.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'nested', 'npmrc')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(runtime, 'node_modules', 'npm', 'node_modules', 'make-fetch-happen', 'lib', 'cache', 'policy.js')), await readFile(dependencyPolicy));
  });
});

test('Windows runtime preserves direct native executable staging and requires a PE header', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const staged = await stageWindowsCommand({ executable: process.execPath, args: ['--version'] }, runtime, limits);
    assert.equal(path.basename(staged.executable).toLowerCase(), 'node.exe');
    assert.deepEqual(staged.args, ['--version']);
    assert.deepEqual(staged.pathEntries, [runtime]);
    assert.equal(staged.comspec, undefined);
    const malformed = path.join(outside, 'not-a-pe.exe');
    await writeFile(malformed, 'MZ');
    await runtimeFixture(async malformedRuntime => {
      await assert.rejects(stageWindowsCommand({ executable: malformed, args: [] }, malformedRuntime, limits), { code: 'WINDOWS_EXECUTABLE_UNSUPPORTED' });
    });
  });
});

test('portable selection preserves a custom Node executable instead of substituting the portable runtime', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const customNode = path.join(outside, 'custom-node.exe');
    await copyFile(process.execPath, customNode);
    const staged = await stageWindowsCommand({ executable: customNode, args: ['--version'] }, runtime, limits,
      { mode: 'portable', portableNodeCacheDirectory: path.join(outside, 'unused-portable-cache') });
    assert.equal(staged.portableNode, undefined);
    assert.deepEqual(await readFile(staged.executable), await readFile(customNode));
  });
});

test('Windows runtime rejects malformed npm wrappers, unknown scripts and traversal', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const malformed = path.join(outside, 'npm.cmd');
    await writeFile(malformed, '@echo off\r\nrem no npm cli layout\r\n');
    await assert.rejects(stageWindowsCommand({ executable: malformed, args: [] }, runtime, limits), { code: 'WINDOWS_NPM_LAYOUT_UNSUPPORTED' });
  });
  await runtimeFixture(async runtime => {
    await assert.rejects(stageWindowsCommand({ executable: 'unknown-test.cmd', args: [] }, runtime, limits), { code: 'WINDOWS_COMMAND_UNSUPPORTED' });
    await assert.rejects(stageWindowsCommand({ executable: '..\\npm.cmd', args: [] }, runtime, limits), { code: 'INVALID_TEST_COMMAND' });
  });
});

test('Windows runtime rejects executable links', { skip: process.platform !== 'win32' }, async t => {
  await runtimeFixture(async (runtime, outside) => {
    const hardLinkSource = path.join(outside, 'source.exe');
    const hardLink = path.join(outside, 'linked.exe');
    await writeFile(hardLinkSource, 'MZ');
    try {
      await link(hardLinkSource, hardLink);
    } catch (error) {
      t.skip('Creating Windows hard links is unavailable: ' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    await assert.rejects(stageWindowsCommand({ executable: hardLink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
    const executableLink = path.join(outside, 'node.exe');
    try {
      await symlink(process.execPath, executableLink, 'file');
    } catch (error) {
      return;
    }
    await assert.rejects(stageWindowsCommand({ executable: executableLink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
  });
});

test('Windows runtime enforces byte and file limits before execution', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async runtime => {
    await assert.rejects(stageWindowsCommand({ executable: 'npm.cmd', args: [] }, runtime, { maxBytes: 1, maxFiles: limits.maxFiles }), { code: 'ISOLATION_TOO_LARGE' });
  });
  await runtimeFixture(async runtime => {
    await assert.rejects(stageWindowsCommand({ executable: 'npm.cmd', args: [] }, runtime, { maxBytes: limits.maxBytes, maxFiles: 1 }), { code: 'ISOLATION_TOO_LARGE' });
  });
});
