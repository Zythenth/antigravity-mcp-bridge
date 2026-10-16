import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { cacheLeafName, resolvePortableNodeRuntime } from '../src/portable-node.js';
import { portableNodeDescriptor } from '../src/portable-node-descriptor.js';
import { stageWindowsCommand } from '../src/windows-runtime.js';

const limits = { maxBytes: 256 * 1024 * 1024, maxFiles: 10_000 };

async function runtimeFixture<T>(run: (runtime: string, outside: string) => Promise<T>): Promise<T> {
  const tempPath = os.tmpdir();
  const canonicalTemp = await realpath(tempPath);
  const runtime = await mkdtemp(path.join(tempPath, 'agy-mcp-runtime-test-'));
  const outside = await mkdtemp(path.join(tempPath, 'agy-mcp-runtime-private-'));
  try {
    return await run(runtime, outside);
  } finally {
    for (const [directory, prefix] of [[runtime, 'agy-mcp-runtime-test-'], [outside, 'agy-mcp-runtime-private-']] as const) {
      const canonical = await realpath(directory);
      assert.equal(path.dirname(canonical), canonicalTemp);
      assert.ok(path.basename(canonical).startsWith(prefix));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
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
      const sourceConfig = await readFile(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'npmrc'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      const stagedConfig = path.join(runtime, 'node_modules', 'npm', 'npmrc');
      if (sourceConfig === undefined) {
        await assert.rejects(lstat(stagedConfig), { code: 'ENOENT' });
      } else {
        const bundledConfig = await readFile(stagedConfig, 'utf8');
        assert.equal(bundledConfig, sourceConfig);
        assert.doesNotMatch(bundledConfig, /private-marker/u);
      }
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
    const bundledConfig = 'prefix=${APPDATA}\n';
    await writeFile(path.join(npmRoot, 'npmrc'), bundledConfig);
    for (const file of ['.npmrc', '.netrc', 'credentials', 'credentials.json', 'nested/npmrc']) {
      const target = path.join(npmRoot, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'omit-credential');
    }
    await stageWindowsCommand({ executable: npm, args: [] }, runtime, limits);
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'cache')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(runtime, 'node_modules', 'npm', 'npmrc'), 'utf8'), bundledConfig);
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', '.npmrc')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', '.netrc')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'credentials')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'credentials.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'nested', 'npmrc')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(runtime, 'node_modules', 'npm', 'node_modules', 'make-fetch-happen', 'lib', 'cache', 'policy.js')), await readFile(dependencyPolicy));
  });
});

test('Windows runtime accepts npm without bundled config and rejects bundled credentials', { skip: process.platform !== 'win32' }, async t => {
  for (const config of [undefined, '//registry.example.invalid/:_authToken=private-marker\n']) {
    await t.test(config === undefined ? 'absent npmrc' : 'credential-bearing npmrc', async () => {
      await runtimeFixture(async (runtime, outside) => {
        const npm = path.join(outside, 'npm.cmd');
        const npmRoot = path.join(outside, 'node_modules', 'npm');
        await copyFile(process.execPath, path.join(outside, 'node.exe'));
        await writeFile(npm, '@echo off\r\nnode_modules\\npm\\bin\\npm-cli.js\r\n');
        await mkdir(path.join(npmRoot, 'bin'), { recursive: true });
        await writeFile(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
        await writeFile(path.join(npmRoot, 'bin', 'npm-cli.js'), '');
        if (config === undefined) {
          await stageWindowsCommand({ executable: npm, args: [] }, runtime, limits);
          await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'npmrc')), { code: 'ENOENT' });
        } else {
          await writeFile(path.join(npmRoot, 'npmrc'), config);
          await assert.rejects(stageWindowsCommand({ executable: npm, args: [] }, runtime, limits), { code: 'WINDOWS_NPM_LAYOUT_UNSUPPORTED' });
          await assert.rejects(lstat(path.join(runtime, 'node_modules', 'npm', 'npmrc')), { code: 'ENOENT' });
        }
      });
    });
  }
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

test('Windows runtime rejects executable hard links', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const source = path.join(outside, 'source.exe');
    const hardLink = path.join(outside, 'linked.exe');
    await writeFile(source, 'MZ');
    await link(source, hardLink);
    await assert.rejects(stageWindowsCommand({ executable: hardLink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
  });
});

test('Windows runtime rejects valid and broken executable symlinks', { skip: process.platform !== 'win32' }, async t => {
  for (const broken of [false, true]) {
    await t.test(broken ? 'broken target' : 'valid target', async t => {
      await runtimeFixture(async (runtime, outside) => {
        const executableLink = path.join(outside, 'node.exe');
        try {
          await symlink(broken ? path.join(outside, 'missing.exe') : process.execPath, executableLink, 'file');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          t.skip('Creating Windows file symlinks requires privileges unavailable to this process');
          return;
        }
        await assert.rejects(stageWindowsCommand({ executable: executableLink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
      });
    });
  }
});

test('Windows runtime rejects valid and broken junctions at executable paths', { skip: process.platform !== 'win32' }, async t => {
  for (const broken of [false, true]) {
    await t.test(broken ? 'broken junction' : 'valid junction', async () => {
      await runtimeFixture(async (runtime, outside) => {
        const target = path.join(outside, 'target');
        const executableLink = path.join(outside, 'linked.exe');
        if (!broken) await mkdir(target);
        await symlink(target, executableLink, 'junction');
        assert.equal((await lstat(executableLink)).isSymbolicLink(), true);
        await assert.rejects(stageWindowsCommand({ executable: executableLink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
      });
    });
  }
});

test('Windows runtime rejects executables below a junction', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const source = path.join(outside, 'source');
    const alias = path.join(outside, 'alias');
    await mkdir(source);
    await copyFile(process.execPath, path.join(source, 'custom.exe'));
    await symlink(source, alias, 'junction');
    await assert.rejects(stageWindowsCommand({ executable: path.join(alias, 'custom.exe'), args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
  });
});

test('Windows runtime searches PATH past missing files and directories and reports absent executables', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const missing = path.join(outside, 'missing');
    const first = path.join(outside, 'first');
    const second = path.join(outside, 'second');
    await mkdir(path.join(first, 'custom.exe'), { recursive: true });
    await mkdir(second);
    await copyFile(process.execPath, path.join(second, 'custom.exe'));
    const original = process.env.PATH;
    process.env.PATH = [missing, first, second].join(path.delimiter);
    try {
      const staged = await stageWindowsCommand({ executable: 'custom.exe', args: ['--version'] }, runtime, limits);
      assert.deepEqual(staged.args, ['--version']);
      assert.deepEqual(await readFile(staged.executable), await readFile(path.join(second, 'custom.exe')));
      await runtimeFixture(async emptyRuntime => {
        await assert.rejects(stageWindowsCommand({ executable: 'absent.exe', args: [] }, emptyRuntime, limits), { code: 'WINDOWS_EXECUTABLE_NOT_FOUND' });
      });
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
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

test('Windows runtime stages pinned source with hardlink, enforces single-link read-only destination, rejects tampering, and keeps generic multi-link rejection', { skip: process.platform !== 'win32' }, async t => {
  if (!portableNodeDescriptor.available) {
    t.skip('Portable Node descriptor is not available; skipping integration test');
    return;
  }
  const descriptor = portableNodeDescriptor;
  const config = loadConfig();
  const configuredCache = config.windowsNodeCacheDirectory;
  let trustedRuntime: Awaited<ReturnType<typeof resolvePortableNodeRuntime>>;
  try {
    trustedRuntime = await resolvePortableNodeRuntime(configuredCache, descriptor);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PORTABLE_NODE_NOT_PREPARED') {
      t.skip('Portable Node cache has not been prepared; skipping integration test');
      return;
    }
    throw error;
  }

  await runtimeFixture(async (runtime, outside) => {
    // 1. Generic executable with hardlink must be rejected
    const genericExe = path.join(outside, 'generic.exe');
    const genericHardlink = path.join(outside, 'generic-alias.exe');
    await writeFile(genericExe, 'MZ\0\0PE\0\0');
    await link(genericExe, genericHardlink);
    await assert.rejects(stageWindowsCommand({ executable: genericHardlink, args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
    await unlink(genericHardlink);
    await unlink(genericExe);

    // 2. Clone the 3 trusted pinned assets to a new local cache outside the original cache
    const testCache = path.join(outside, 'portable-cache');
    const leaf = cacheLeafName(descriptor);
    const trustedLeafDir = path.join(configuredCache, leaf);
    const testLeafDir = path.join(testCache, leaf);
    await mkdir(testLeafDir, { recursive: true });

    for (const assetName of ['node.exe', 'LICENSE', 'build.json'] as const) {
      await copyFile(path.join(trustedLeafDir, assetName), path.join(testLeafDir, assetName));
    }

    // Set clone node.exe mode to 0o600 so it can be tampered later
    const cloneNode = path.join(testLeafDir, 'node.exe');
    await chmod(cloneNode, 0o600);

    // Create an alias outside the leaf directory (nlink >= 2 on cloneNode)
    const cloneAlias = path.join(outside, 'node-alias.exe');
    await link(cloneNode, cloneAlias);

    // Stage using exact process.execPath with mode: 'portable' and testCache
    const staged = await stageWindowsCommand({ executable: process.execPath, args: ['--version'] }, runtime, limits, {
      mode: 'portable',
      portableNodeCacheDirectory: testCache,
    });

    assert.equal(staged.portableNode?.sha256, descriptor.assets.node.sha256);
    const destStat = await lstat(staged.executable);
    assert.equal(destStat.isFile(), true);
    assert.equal(destStat.nlink, 1);
    assert.equal((destStat.mode & 0o222), 0, 'destination must be read-only');
    assert.equal(createHash('sha256').update(await readFile(staged.executable)).digest('hex'), descriptor.assets.node.sha256);

    // Verify alias and clone source remain intact on disk with nlink >= 2
    const cloneAliasStat = await lstat(cloneAlias);
    assert.equal(cloneAliasStat.isFile(), true);
    assert.ok(cloneAliasStat.nlink >= 2);

    // 3. Tamper clone via alias with exact same size (modify last byte)
    const handle = await open(cloneAlias, 'r+');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, descriptor.assets.node.bytes - 1);
      const byteVal = buffer[0];
      if (byteVal === undefined) throw new Error('Expected byte to be read');
      buffer[0] = byteVal ^ 0xff;
      await handle.write(buffer, 0, 1, descriptor.assets.node.bytes - 1);
    } finally {
      await handle.close();
    }

    // Staging must fail with PORTABLE_NODE_HASH_MISMATCH
    await runtimeFixture(async secondRuntime => {
      await assert.rejects(stageWindowsCommand({ executable: process.execPath, args: ['--version'] }, secondRuntime, limits, {
        mode: 'portable',
        portableNodeCacheDirectory: testCache,
      }), { code: 'PORTABLE_NODE_HASH_MISMATCH' });
    });

    // Verify tampered bytes and alias are preserved on disk without repair
    const tamperedAliasBytes = await readFile(cloneAlias);
    const tamperedCloneBytes = await readFile(cloneNode);
    assert.deepEqual(tamperedAliasBytes, tamperedCloneBytes);
    assert.notEqual(createHash('sha256').update(tamperedAliasBytes).digest('hex'), descriptor.assets.node.sha256);

    // Original cache remains completely untouched
    const originalNodeBytes = await readFile(trustedRuntime.nodePath);
    assert.equal(createHash('sha256').update(originalNodeBytes).digest('hex'), descriptor.assets.node.sha256);

    await unlink(cloneAlias);
  });
});

test('Windows runtime rejects Git native layout junctions before staging', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const image = Buffer.alloc(128);
    image.write('MZ', 0, 2, 'ascii');
    image.writeUInt32LE(64, 0x3c);
    image.write('PE\0\0', 64, 4, 'ascii');
    const cmd = path.join(outside, 'git-junction-target', 'cmd');
    const native = path.join(outside, 'target-native', 'bin');
    await mkdir(cmd, { recursive: true });
    await mkdir(native, { recursive: true });
    await writeFile(path.join(cmd, 'git.exe'), image);
    await writeFile(path.join(native, 'git.exe'), image);
    await symlink(path.dirname(native), path.join(path.dirname(cmd), 'ucrt64'), 'junction');
    await assert.rejects(stageWindowsCommand({ executable: path.join(cmd, 'git.exe'), args: [] }, runtime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
    assert.deepEqual(await readdir(runtime), []);
  });
});

test('Windows runtime stages hardlinked Git sources to singlelink read-only destination and resolves cmd layouts', { skip: process.platform !== 'win32' }, async () => {
  await runtimeFixture(async (runtime, outside) => {
    const peStub = Buffer.alloc(256);
    peStub.write('MZ', 0, 2, 'ascii');
    peStub.writeUInt32LE(64, 0x3c);
    peStub.write('PE\0\0', 64, 4, 'ascii');
    peStub.write('NATIVE-GIT', 72, 'ascii');
    const peHash = createHash('sha256').update(peStub).digest('hex');

    const launcherStub = Buffer.alloc(128);
    launcherStub.write('MZ', 0, 2, 'ascii');
    launcherStub.writeUInt32LE(64, 0x3c);
    launcherStub.write('PE\0\0', 64, 4, 'ascii');
    launcherStub.write('LAUNCHER-WRAPPER', 72, 'ascii');
    const launcherHash = createHash('sha256').update(launcherStub).digest('hex');
    assert.notEqual(peHash, launcherHash);
    assert.notEqual(peStub.length, launcherStub.length);

    const gitBase = path.join(outside, 'git-mingw');
    const cmdDir = path.join(gitBase, 'cmd');
    const binDir = path.join(gitBase, 'bin');
    const nativeDir = path.join(gitBase, 'mingw64', 'bin');
    await mkdir(cmdDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(nativeDir, { recursive: true });

    const cmdGit = path.join(cmdDir, 'git.exe');
    const binGit = path.join(binDir, 'git.exe');
    const realGit = path.join(nativeDir, 'git.exe');
    const gitHardlink = path.join(outside, 'git-alias.exe');
    await writeFile(realGit, peStub);
    await writeFile(cmdGit, launcherStub);
    await writeFile(binGit, launcherStub);
    await link(realGit, gitHardlink);

    const dll = path.join(nativeDir, 'libgit.dll');
    const dllHardlink = path.join(outside, 'libgit-alias.dll');
    await writeFile(dll, peStub);
    await link(dll, dllHardlink);

    const helpers = ['git-upload-pack.exe', 'git-receive-pack.exe', 'git-upload-archive.exe'];
    for (const helper of helpers) {
      const helperPath = path.join(nativeDir, helper);
      const helperLink = path.join(outside, helper + '-alias.exe');
      await writeFile(helperPath, peStub);
      await link(helperPath, helperLink);
    }

    const beforeStat = await lstat(realGit);
    assert.ok(beforeStat.nlink >= 2);

    const staged = await stageWindowsCommand({ executable: cmdGit, args: ['--version'] }, runtime, limits);
    assert.equal(staged.executable, path.join(runtime, 'git', 'bin', 'git.exe'));
    assert.equal(staged.gitExecPath, path.join(runtime, 'git', 'bin'));
    assert.deepEqual(staged.pathEntries, [path.join(runtime, 'git', 'bin')]);

    const destStat = await lstat(staged.executable);
    assert.equal(destStat.nlink, 1);
    assert.equal(destStat.mode & 0o222, 0);
    const stagedBytes = await readFile(staged.executable);
    assert.equal(createHash('sha256').update(stagedBytes).digest('hex'), peHash);
    assert.notEqual(createHash('sha256').update(stagedBytes).digest('hex'), launcherHash);

    const destDllStat = await lstat(path.join(runtime, 'git', 'bin', 'libgit.dll'));
    assert.equal(destDllStat.nlink, 1);
    assert.equal(destDllStat.mode & 0o222, 0);

    for (const helper of helpers) {
      const destHelperStat = await lstat(path.join(runtime, 'git', 'bin', helper));
      assert.equal(destHelperStat.nlink, 1);
      assert.equal(destHelperStat.mode & 0o222, 0);
    }

    const afterStat = await lstat(realGit);
    assert.equal(afterStat.nlink, beforeStat.nlink);

    await runtimeFixture(async binRuntime => {
      const binStaged = await stageWindowsCommand({ executable: binGit, args: ['--version'] }, binRuntime, limits);
      assert.equal(binStaged.executable, path.join(binRuntime, 'git', 'bin', 'git.exe'));
      assert.equal(binStaged.gitExecPath, path.join(binRuntime, 'git', 'bin'));
      const stagedBinBytes = await readFile(binStaged.executable);
      assert.equal(createHash('sha256').update(stagedBinBytes).digest('hex'), peHash);
      assert.notEqual(createHash('sha256').update(stagedBinBytes).digest('hex'), launcherHash);
    });

    await runtimeFixture(async nativeDirectRuntime => {
      const nativeStaged = await stageWindowsCommand({ executable: realGit, args: ['--version'] }, nativeDirectRuntime, limits);
      assert.equal(nativeStaged.executable, path.join(nativeDirectRuntime, 'git', 'bin', 'git.exe'));
      assert.equal(nativeStaged.gitExecPath, path.join(nativeDirectRuntime, 'git', 'bin'));
      const stagedNativeBytes = await readFile(nativeStaged.executable);
      assert.equal(createHash('sha256').update(stagedNativeBytes).digest('hex'), peHash);
    });

    await runtimeFixture(async standaloneRuntime => {
      const standaloneDir = path.join(outside, 'standalone-git');
      await mkdir(standaloneDir, { recursive: true });
      const standaloneStub = Buffer.alloc(192);
      standaloneStub.write('MZ', 0, 2, 'ascii');
      standaloneStub.writeUInt32LE(64, 0x3c);
      standaloneStub.write('PE\0\0', 64, 4, 'ascii');
      standaloneStub.write('STANDALONE-GIT', 72, 'ascii');
      const standaloneHash = createHash('sha256').update(standaloneStub).digest('hex');
      const standaloneExe = path.join(standaloneDir, 'git.exe');
      await writeFile(standaloneExe, standaloneStub);

      const standaloneStaged = await stageWindowsCommand({ executable: standaloneExe, args: ['status'] }, standaloneRuntime, limits);
      assert.equal(standaloneStaged.executable, path.join(standaloneRuntime, 'git', 'bin', 'git.exe'));
      const stagedStandaloneBytes = await readFile(standaloneStaged.executable);
      assert.equal(createHash('sha256').update(stagedStandaloneBytes).digest('hex'), standaloneHash);
    });

    // Negative control: standalone native git.exe in a directory named 'bin' without distribution siblings
    await runtimeFixture(async standaloneBinRuntime => {
      const standaloneBinDir = path.join(outside, 'standalone-tool', 'bin');
      await mkdir(standaloneBinDir, { recursive: true });
      const standaloneBinStub = Buffer.alloc(160);
      standaloneBinStub.write('MZ', 0, 2, 'ascii');
      standaloneBinStub.writeUInt32LE(64, 0x3c);
      standaloneBinStub.write('PE\0\0', 64, 4, 'ascii');
      standaloneBinStub.write('STANDALONE-BIN-GIT', 72, 'ascii');
      const standaloneBinHash = createHash('sha256').update(standaloneBinStub).digest('hex');
      const standaloneBinExe = path.join(standaloneBinDir, 'git.exe');
      await writeFile(standaloneBinExe, standaloneBinStub);

      const staged = await stageWindowsCommand({ executable: standaloneBinExe, args: ['status'] }, standaloneBinRuntime, limits);
      assert.equal(staged.executable, path.join(standaloneBinRuntime, 'git', 'bin', 'git.exe'));
      const stagedBytes = await readFile(staged.executable);
      assert.equal(createHash('sha256').update(stagedBytes).digest('hex'), standaloneBinHash);
    });

    // Native git.exe in another native layout name (e.g. clangarm64/bin) without distribution wrappers
    await runtimeFixture(async otherNativeRuntime => {
      const otherNativeDir = path.join(outside, 'other-dist', 'clangarm64', 'bin');
      await mkdir(otherNativeDir, { recursive: true });
      const otherNativeStub = Buffer.alloc(176);
      otherNativeStub.write('MZ', 0, 2, 'ascii');
      otherNativeStub.writeUInt32LE(64, 0x3c);
      otherNativeStub.write('PE\0\0', 64, 4, 'ascii');
      otherNativeStub.write('CLANGARM64-GIT', 72, 'ascii');
      const otherNativeHash = createHash('sha256').update(otherNativeStub).digest('hex');
      const otherNativeExe = path.join(otherNativeDir, 'git.exe');
      await writeFile(otherNativeExe, otherNativeStub);

      const staged = await stageWindowsCommand({ executable: otherNativeExe, args: ['version'] }, otherNativeRuntime, limits);
      assert.equal(staged.executable, path.join(otherNativeRuntime, 'git', 'bin', 'git.exe'));
      const stagedBytes = await readFile(staged.executable);
      assert.equal(createHash('sha256').update(stagedBytes).digest('hex'), otherNativeHash);
    });

    await runtimeFixture(async ucrtRuntime => {
      const ucrtBase = path.join(outside, 'git-ucrt');
      const ucrtCmdDir = path.join(ucrtBase, 'cmd');
      const ucrtBinDir = path.join(ucrtBase, 'bin');
      const ucrtNativeDir = path.join(ucrtBase, 'ucrt64', 'bin');
      await mkdir(ucrtCmdDir, { recursive: true });
      await mkdir(ucrtBinDir, { recursive: true });
      await mkdir(ucrtNativeDir, { recursive: true });
      await writeFile(path.join(ucrtCmdDir, 'git.exe'), launcherStub);
      await writeFile(path.join(ucrtBinDir, 'git.exe'), launcherStub);
      await writeFile(path.join(ucrtNativeDir, 'git.exe'), peStub);

      const ucrtCmdStaged = await stageWindowsCommand({ executable: path.join(ucrtCmdDir, 'git.exe'), args: ['status'] }, ucrtRuntime, limits);
      assert.equal(ucrtCmdStaged.executable, path.join(ucrtRuntime, 'git', 'bin', 'git.exe'));
      assert.equal(createHash('sha256').update(await readFile(ucrtCmdStaged.executable)).digest('hex'), peHash);

      await runtimeFixture(async ucrtBinRuntime => {
        const ucrtBinStaged = await stageWindowsCommand({ executable: path.join(ucrtBinDir, 'git.exe'), args: ['status'] }, ucrtBinRuntime, limits);
        assert.equal(ucrtBinStaged.executable, path.join(ucrtBinRuntime, 'git', 'bin', 'git.exe'));
        assert.equal(createHash('sha256').update(await readFile(ucrtBinStaged.executable)).digest('hex'), peHash);
      });
    });

    // ucrt64 precedence when both ucrt64 and mingw64 native layouts exist with distinct bytes
    await runtimeFixture(async precedenceRuntime => {
      const precBase = path.join(outside, 'git-precedence');
      const precCmdDir = path.join(precBase, 'cmd');
      const precUcrtDir = path.join(precBase, 'ucrt64', 'bin');
      const precMingwDir = path.join(precBase, 'mingw64', 'bin');
      await mkdir(precCmdDir, { recursive: true });
      await mkdir(precUcrtDir, { recursive: true });
      await mkdir(precMingwDir, { recursive: true });

      const ucrtStub = Buffer.alloc(200);
      ucrtStub.write('MZ', 0, 2, 'ascii');
      ucrtStub.writeUInt32LE(64, 0x3c);
      ucrtStub.write('PE\0\0', 64, 4, 'ascii');
      ucrtStub.write('UCRT-WINNER', 72, 'ascii');
      const ucrtHash = createHash('sha256').update(ucrtStub).digest('hex');

      const mingwStub = Buffer.alloc(210);
      mingwStub.write('MZ', 0, 2, 'ascii');
      mingwStub.writeUInt32LE(64, 0x3c);
      mingwStub.write('PE\0\0', 64, 4, 'ascii');
      mingwStub.write('MINGW-LOSER', 72, 'ascii');
      const mingwHash = createHash('sha256').update(mingwStub).digest('hex');
      assert.notEqual(ucrtHash, mingwHash);

      await writeFile(path.join(precCmdDir, 'git.exe'), launcherStub);
      await writeFile(path.join(precUcrtDir, 'git.exe'), ucrtStub);
      await writeFile(path.join(precMingwDir, 'git.exe'), mingwStub);

      const precStaged = await stageWindowsCommand({ executable: path.join(precCmdDir, 'git.exe'), args: ['status'] }, precedenceRuntime, limits);
      assert.equal(precStaged.executable, path.join(precedenceRuntime, 'git', 'bin', 'git.exe'));
      const stagedPrecBytes = await readFile(precStaged.executable);
      assert.equal(createHash('sha256').update(stagedPrecBytes).digest('hex'), ucrtHash);
      assert.notEqual(createHash('sha256').update(stagedPrecBytes).digest('hex'), mingwHash);
    });

    await runtimeFixture(async brokenRuntime => {
      const brokenCmdDir = path.join(outside, 'git-broken-cmd', 'cmd');
      await mkdir(brokenCmdDir, { recursive: true });
      const brokenCmd = path.join(brokenCmdDir, 'git.exe');
      await writeFile(brokenCmd, launcherStub);
      await assert.rejects(stageWindowsCommand({ executable: brokenCmd, args: [] }, brokenRuntime, limits), { code: 'WINDOWS_EXECUTABLE_UNSUPPORTED' });
    });

    // Known distribution layout where bin has a ucrt64 sibling directory but no valid native git.exe
    await runtimeFixture(async brokenBinRuntime => {
      const brokenBinBase = path.join(outside, 'git-broken-bin');
      const brokenBinDir = path.join(brokenBinBase, 'bin');
      const brokenUcrtDir = path.join(brokenBinBase, 'ucrt64', 'bin');
      await mkdir(brokenBinDir, { recursive: true });
      await mkdir(brokenUcrtDir, { recursive: true });
      const brokenBin = path.join(brokenBinDir, 'git.exe');
      await writeFile(brokenBin, launcherStub);
      // ucrt64/bin exists but git.exe is missing
      await assert.rejects(stageWindowsCommand({ executable: brokenBin, args: [] }, brokenBinRuntime, limits), { code: 'WINDOWS_EXECUTABLE_UNSUPPORTED' });
    });

    // Directory-invalid target: native layout target is a directory rather than a file
    await runtimeFixture(async dirTargetRuntime => {
      const dirTargetBase = path.join(outside, 'git-dir-target');
      const dirTargetCmd = path.join(dirTargetBase, 'cmd');
      const dirTargetUcrt = path.join(dirTargetBase, 'ucrt64', 'bin', 'git.exe');
      await mkdir(dirTargetCmd, { recursive: true });
      await mkdir(dirTargetUcrt, { recursive: true }); // directory named git.exe!
      await writeFile(path.join(dirTargetCmd, 'git.exe'), launcherStub);

      await assert.rejects(stageWindowsCommand({ executable: path.join(dirTargetCmd, 'git.exe'), args: [] }, dirTargetRuntime, limits), { code: 'WINDOWS_EXECUTABLE_UNSUPPORTED' });
      // Verify runtime directory remains clean/empty
      const stagedEntries = await readdir(dirTargetRuntime);
      assert.deepEqual(stagedEntries, []);
    });

    // Exact byte budget: git.exe + 1 DLL + 3 helpers (each 256 bytes = 5 * 256 = 1280 bytes)
    const exactGitBytes = (1 + 1 + helpers.length) * peStub.length;
    await runtimeFixture(async exactBytesRuntime => {
      const stagedExact = await stageWindowsCommand({ executable: cmdGit, args: ['--version'] }, exactBytesRuntime, {
        maxBytes: exactGitBytes,
        maxFiles: 1000,
      });
      assert.equal(stagedExact.executable, path.join(exactBytesRuntime, 'git', 'bin', 'git.exe'));
    });

    // Exact byte budget minus 1: must fail with ISOLATION_TOO_LARGE
    await runtimeFixture(async underBytesRuntime => {
      await assert.rejects(stageWindowsCommand({ executable: cmdGit, args: [] }, underBytesRuntime, {
        maxBytes: exactGitBytes - 1,
        maxFiles: 1000,
      }), { code: 'ISOLATION_TOO_LARGE' });
    });

    // Exact file budget: 2 directories ('git', 'git/bin') + 5 files = 7 entries
    const exactGitEntries = 2 + 1 + 1 + helpers.length;
    await runtimeFixture(async exactFilesRuntime => {
      const stagedExactFiles = await stageWindowsCommand({ executable: cmdGit, args: ['--version'] }, exactFilesRuntime, {
        maxBytes: exactGitBytes * 2,
        maxFiles: exactGitEntries,
      });
      assert.equal(stagedExactFiles.executable, path.join(exactFilesRuntime, 'git', 'bin', 'git.exe'));
    });

    // Exact file budget minus 1: must fail with ISOLATION_TOO_LARGE
    await runtimeFixture(async underFilesRuntime => {
      await assert.rejects(stageWindowsCommand({ executable: cmdGit, args: [] }, underFilesRuntime, {
        maxBytes: exactGitBytes * 2,
        maxFiles: exactGitEntries - 1,
      }), { code: 'ISOLATION_TOO_LARGE' });
    });

    await runtimeFixture(async absentRuntime => {
      const emptyDir = path.join(outside, 'empty-path');
      await mkdir(emptyDir, { recursive: true });
      const prevPath = process.env.PATH;
      process.env.PATH = emptyDir;
      try {
        const stagedAbsent = await stageWindowsCommand({ executable: process.execPath, args: ['--version'] }, absentRuntime, limits, { includeGit: true });
        assert.equal(stagedAbsent.gitExecPath, undefined);
        assert.deepEqual(stagedAbsent.pathEntries, [absentRuntime]);
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    });

    await runtimeFixture(async genericRuntime => {
      const genericExe = path.join(outside, 'generic.exe');
      const genericLink = path.join(outside, 'generic-alias.exe');
      await writeFile(genericExe, peStub);
      await link(genericExe, genericLink);
      await assert.rejects(stageWindowsCommand({ executable: genericLink, args: [] }, genericRuntime, limits), { code: 'UNSAFE_RUNTIME_PATH' });
    });
  });
});
