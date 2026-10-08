import assert from 'node:assert/strict';
import childProcess, { execFileSync, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { cacheLeafName, portableNodeStatus, preparePortableNodeRuntime, resolvePortableNodeRuntime } from '../src/portable-node.js';
import type { AvailablePortableNodeDescriptor, PortableNodeDescriptor } from '../src/portable-node-descriptor.js';

const releaseRepository = 'https://github.com/Zythenth/antigravity-mcp-bridge';
const releaseTag = 'runtime-node-v24.21.0-lpac1-win-x64';
const shortTemporaryRoot = path.join(process.cwd(), `.pn-${process.pid}`);

after(async () => {
  assert.equal(path.dirname(shortTemporaryRoot), process.cwd());
  assert.equal(path.basename(shortTemporaryRoot), `.pn-${process.pid}`);
  await rm(shortTemporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function fixtureDescriptor() {
  const files = new Map([
    ['node.exe', Buffer.from('MZ portable Node test executable\n')],
    ['LICENSE', Buffer.from('portable Node test license\n')],
    ['build.json', Buffer.from('{"build":"portable-node-test"}\n')],
  ]);
  const asset = (fileName: 'node.exe' | 'LICENSE' | 'build.json') => {
    const contents = files.get(fileName)!;
    return {
      fileName,
      url: `${releaseRepository}/releases/download/${releaseTag}/${fileName}`,
      bytes: contents.length,
      sha256: sha256(contents),
    };
  };
  const descriptor: AvailablePortableNodeDescriptor = {
    available: true,
    buildId: 'node-v24.21.0-lpac1-win-x64',
    releaseTag,
    releaseRepository,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24.21.0',
    moduleAbi: 137,
    libuvVersion: '1.52.1',
    libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
    source: {
      repository: 'https://github.com/nodejs/node',
      ref: 'v24.21.0',
      libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
    },
    assets: { node: asset('node.exe'), license: asset('LICENSE'), buildMetadata: asset('build.json') },
  };
  return { descriptor, files };
}

function assetFetch(files: Map<string, Buffer>, onRequest?: () => void): typeof globalThis.fetch {
  return async input => {
    onRequest?.();
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const name = url.pathname.split('/').at(-1)!;
    const contents = files.get(name);
    if (!contents) return new Response(null, { status: 404 });
    return new Response(contents, { status: 200, headers: { 'content-length': String(contents.length) } });
  };
}

async function cacheFixture<T>(run: (cache: string) => Promise<T>): Promise<T> {
  await rm(shortTemporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  await mkdir(shortTemporaryRoot, { recursive: true, mode: 0o700 });
  const cache = shortTemporaryRoot;
  try {
    return await run(cache);
  } finally {
    await rm(cache, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => typeof error === 'object' && error !== null && 'code' in error && error.code === code);
}

test('startup rejects non-local cache configuration before resolving it', { skip: process.platform !== 'win32' }, () => {
  for (const value of ['relative-cache', '..\\cache', '\\\\server\\share\\cache', '\\\\?\\C:\\cache', 'C:\\cache:stream', 'C:\\']) {
    assert.throws(() => loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: value }), /BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY/u);
  }
  assert.equal(loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: path.join(process.cwd(), '.cache') }).windowsNodeCacheDirectory,
    path.resolve(process.cwd(), '.cache'));
});

test('TaskManager rejects source/cache overlap before model lookup, queueing, or copying', async t => {
  await cacheFixture(async root => {
    const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
    const { files } = fixtureDescriptor();
    for (const scenario of ['cache-inside-source', 'source-inside-cache', 'same-directory', 'missing-cache', 'junction-missing-cache']) {
      const directory = path.join(root, scenario);
      const source = path.join(directory, 'source');
      execFileSync('git', ['init', '--quiet', source], { windowsHide: true });
      await writeFile(path.join(source, 'source.txt'), 'source');
      let cache = scenario === 'source-inside-cache' ? directory : scenario === 'same-directory' ? source : path.join(source, 'runtime-cache');
      const missing = scenario === 'missing-cache' || scenario === 'junction-missing-cache';
      if (scenario === 'junction-missing-cache') {
        const alias = path.join(directory, 'cache-alias');
        await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
        cache = path.join(alias, 'missing', 'runtime-cache');
      } else if (missing) cache = path.join(source, 'missing', 'runtime-cache');
      if (!missing) {
        await mkdir(cache, { recursive: true });
        for (const [name, contents] of files) await writeFile(path.join(cache, name), contents);
      }
      for (const mode of ['system', 'portable'] as const) {
        const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy',
          BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-' + mode), BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cache,
          ...(mode === 'portable' ? { BRIDGE_WINDOWS_NODE_RUNTIME: mode } : {}) });
        const adapter = new CliAdapter(config, [mockPath]);
        await adapter.discover();
        const modelCalls = t.mock.method(adapter, 'listModels');
        const spawnCalls = t.mock.method(adapter, 'spawnTask');
        const tasks = new TaskManager(adapter, config);
        const events = t.mock.method(tasks.events, 'append');
        try {
          for (const includePaths of [undefined, ['source.txt']]) {
            await assert.rejects(tasks.run({ prompt: 'split:test', workingDirectory: source, model: 'mock-pro', includePaths }),
              error => error instanceof Error && 'code' in error && error.code === 'INVALID_WORKING_DIRECTORY' &&
                /move BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY outside the project/u.test(error.message), scenario + ': ' + mode);
          }
          assert.deepEqual(tasks.list(), [], scenario + ': no task may be queued');
          assert.deepEqual(new StateStore(config.stateDirectory).load(), [], scenario + ': no copy may be persisted');
          assert.equal(events.mock.callCount(), 0, scenario + ': no copy or task event');
          assert.equal(modelCalls.mock.callCount(), 0, scenario + ': no model lookup');
          assert.equal(spawnCalls.mock.callCount(), 0, scenario + ': no model process');
          assert.equal(await readFile(path.join(source, 'source.txt'), 'utf8'), 'source');
          if (missing) await assert.rejects(lstat(cache), { code: 'ENOENT' });
          else for (const [name, contents] of files) assert.deepEqual(await readFile(path.join(cache, name)), contents);
        } finally {
          await tasks.shutdown();
          for (const task of tasks.list()) await tasks.discard(task.taskId);
        }
      }
    }
  });
});

test('TaskManager accepts disjoint source/cache siblings and preserves forbidden descendants', async () => {
  await cacheFixture(async root => {
    const source = path.join(root, 'source');
    const cache = path.join(root, 'source-cache');
    const forbidden = path.join(source, 'forbidden');
    execFileSync('git', ['init', '--quiet', source], { windowsHide: true });
    await writeFile(path.join(source, 'source.txt'), 'source');
    await mkdir(forbidden);
    await mkdir(cache);
    const { files } = fixtureDescriptor();
    for (const [name, contents] of files) await writeFile(path.join(cache, name), contents);
    const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy',
      BRIDGE_STATE_DIRECTORY: path.join(root, 'state'), BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cache,
      FORBIDDEN_DIRECTORIES: forbidden });
    const adapter = new CliAdapter(config, [fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url))]);
    await adapter.discover();
    const tasks = new TaskManager(adapter, config);
    try {
      await assert.rejects(tasks.run({ prompt: 'split:test', workingDirectory: forbidden }), { code: 'INVALID_WORKING_DIRECTORY' });
      const task = await tasks.run({ prompt: 'split:test', workingDirectory: source, model: 'mock-pro' });
      assert.equal((await tasks.wait(task.taskId, 0, 10)).status, 'completed');
      const finished = tasks.status(task.taskId);
      assert.deepEqual(finished.includedFiles, ['source.txt']);
      assert.equal(await readFile(path.join(finished.copyDirectory!, 'source.txt'), 'utf8'), 'source');
      for (const [name, contents] of files) {
        await assert.rejects(readFile(path.join(finished.copyDirectory!, name)), { code: 'ENOENT' });
        assert.deepEqual(await readFile(path.join(cache, name)), contents);
      }
      assert.equal(await readFile(path.join(source, 'source.txt'), 'utf8'), 'source');
    } finally {
      await tasks.shutdown();
      for (const task of tasks.list()) await tasks.discard(task.taskId);
    }
  });
});

test('portable preparation rejects a descriptor for a non-x64 runtime before download', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const { descriptor, files } = fixtureDescriptor();
  const wrongArchitecture = { ...descriptor, arch: 'arm64' } as unknown as PortableNodeDescriptor;
  await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: path.join(process.cwd(), '.unused-cache'), descriptor: wrongArchitecture, fetch: assetFetch(files) }),
    'PORTABLE_NODE_DESCRIPTOR_UNAVAILABLE');
});

test('portable inspection reports bounded failure details without exposing process output', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  const sentinel = 'inspection-output-must-stay-private';
  const cases = [
    { reason: 'timeout', prefix: '[Threading.Thread]::Sleep(16000);' },
    { reason: 'stdout-limit', prefix: `[Console]::Out.Write('${sentinel}'+('x'*2048));[Threading.Thread]::Sleep(6000);` },
    { reason: 'stderr-limit', prefix: `[Console]::Error.Write('${sentinel}'+('x'*2048));[Threading.Thread]::Sleep(6000);` },
    { reason: 'exit-nonzero', suffix: ';exit 7' },
    { reason: 'invalid-safe-output', prefix: `[Console]::Out.Write('${sentinel}');` },
    { reason: 'spawn-error', missingExecutable: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.reason, async subtest => {
      const { descriptor, files } = fixtureDescriptor();
      const cache = path.join(shortTemporaryRoot, 'inspection-diagnostics');
      const originalSpawn = childProcess.spawn;
      const mocked = subtest.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
        assert.ok(Array.isArray(args));
        const encodedIndex = args.indexOf('-EncodedCommand') + 1;
        assert.ok(encodedIndex > 0 && typeof args[encodedIndex] === 'string');
        const script = Buffer.from(args[encodedIndex]!, 'base64').toString('utf16le');
        const changedArgs = [...args];
        changedArgs[encodedIndex] = Buffer.from((scenario.prefix ?? '') + script + (scenario.suffix ?? ''), 'utf16le').toString('base64');
        return originalSpawn(scenario.missingExecutable ? path.join(cache, 'missing-inspector.exe') : command, changedArgs, options);
      });
      syncBuiltinESMExports();
      let requests = 0;
      try {
        await assert.rejects(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) }), error => {
          assert.ok(error instanceof Error && 'code' in error);
          assert.equal(error.code, 'UNSAFE_PORTABLE_NODE_CACHE');
          assert.ok(error.message.includes(`reason=${scenario.reason};`), error.message);
          assert.match(error.message, /elapsedMs=\d+; exitCode=(?:null|-?\d+); signal=(?:null|SIG[A-Z]+); stdoutChars=\d+; stderrChars=\d+; stdoutTruncated=(?:true|false); stderrTruncated=(?:true|false)/u);
          assert.ok(!error.message.includes(sentinel));
          assert.ok(!error.message.includes(cache));
          if (scenario.reason === 'exit-nonzero') assert.ok(error.message.includes('exitCode=7;'));
          if (scenario.reason === 'stdout-limit') assert.ok(error.message.includes('stdoutTruncated=true;'));
          if (scenario.reason === 'stderr-limit') assert.ok(error.message.includes('stderrTruncated=true'));
          return true;
        });
        assert.equal(requests, 0);
        await assert.rejects(lstat(cache), { code: 'ENOENT' });
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
});


test('portable inspection accepts real cache paths without PowerShell modules and tolerates bounded cold startup', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  for (const scenario of [
    { name: 'module-free', directory: 'module-free', firstDelay: 0 },
    { name: 'cold-first-inspection', directory: 'cold', firstDelay: 7000 },
    { name: 'literal-unicode-path', directory: "é 中 ' 😀", firstDelay: 0 },
  ]) {
    await t.test(scenario.name, async subtest => {
      await cacheFixture(async root => {
        const cache = path.join(root, scenario.directory);
        const { descriptor, files } = fixtureDescriptor();
        const originalSpawn = childProcess.spawn;
        let inspections = 0;
        const mocked = subtest.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
          const encodedIndex = args.indexOf('-EncodedCommand') + 1;
          assert.ok(encodedIndex > 0);
          const script = Buffer.from(args[encodedIndex]!, 'base64').toString('utf16le');
          const changedArgs = [...args];
          const delay = inspections++ === 0 && scenario.firstDelay ? '[Threading.Thread]::Sleep(7000);' : '';
          changedArgs[encodedIndex] = Buffer.from(delay + "$PSModuleAutoLoadingPreference='None';" + script, 'utf16le').toString('base64');
          return originalSpawn(command, changedArgs, { ...options, env: { ...process.env, PSModulePath: path.join(root, 'missing-modules') } });
        });
        syncBuiltinESMExports();
        let requests = 0;
        const started = performance.now();
        try {
          const runtime = await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) });
          assert.equal(requests, 3);
          assert.equal(runtime.nodePath, path.join(cache, cacheLeafName(descriptor), 'node.exe'));
          assert.deepEqual(await readFile(runtime.nodePath), files.get('node.exe'));
          assert.equal((await portableNodeStatus('portable', cache, descriptor)).ready, true);
          assert.ok(inspections > 1);
          if (scenario.firstDelay) assert.ok(performance.now() - started >= scenario.firstDelay);
        } finally {
          mocked.mock.restore();
          syncBuiltinESMExports();
        }
      });
    });
  }
});

test('portable inspection rejects unpaired UTF-16 surrogates before cache creation or download', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async root => {
    const { descriptor, files } = fixtureDescriptor();
    for (const name of ['high-\ud800', 'low-\udc00']) {
      const cache = path.join(root, name);
      let requests = 0;
      await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) }), 'UNSAFE_PORTABLE_NODE_CACHE');
      assert.equal(requests, 0);
      await assert.rejects(lstat(cache), { code: 'ENOENT' });
    }
  });
});


test('portable inspection rejects empty or malformed path records before cache creation or download', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  for (const input of ['', '\n', '====\n', 'AA==\n']) {
    await t.test(JSON.stringify(input), async subtest => {
      await cacheFixture(async root => {
        const cache = path.join(root, 'invalid-record');
        const { descriptor, files } = fixtureDescriptor();
        const originalSpawn = childProcess.spawn;
        const mocked = subtest.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
          const child = originalSpawn(command, args, options);
          const originalEnd = child.stdin!.end.bind(child.stdin!);
          subtest.mock.method(child.stdin!, 'end', () => originalEnd(input));
          return child;
        });
        syncBuiltinESMExports();
        let requests = 0;
        try {
          await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) }), 'UNSAFE_PORTABLE_NODE_CACHE');
          assert.equal(requests, 0);
          await assert.rejects(lstat(cache), { code: 'ENOENT' });
        } finally {
          mocked.mock.restore();
          syncBuiltinESMExports();
        }
      });
    });
  }
});

test('portable inspection rejects cache-root and build-directory junctions before use', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async root => {
    const { descriptor, files } = fixtureDescriptor();
    const outside = path.join(root, 'outside');
    const cache = path.join(root, 'cache');
    await mkdir(outside);
    await symlink(outside, cache, 'junction');
    let requests = 0;
    await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) }), 'UNSAFE_PORTABLE_NODE_CACHE');
    assert.equal(requests, 0);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(outside), []);
    await unlink(cache);
    await mkdir(cache);
    await symlink(outside, path.join(cache, cacheLeafName(descriptor)), 'junction');
    await rejectsCode(resolvePortableNodeRuntime(cache, descriptor), 'UNSAFE_PORTABLE_NODE_CACHE');
    assert.deepEqual(await (await import('node:fs/promises')).readdir(outside), []);
  });
});

test('portable runtime preparation accepts only pinned assets and status only reports a verified cache as ready', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async cache => {
    const { descriptor, files } = fixtureDescriptor();
    let requests = 0;
    const runtime = await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { requests++; }) });
    assert.equal(requests, 3);
    assert.equal(runtime.nodePath, path.join(cache, cacheLeafName(descriptor), 'node.exe'));
    assert.deepEqual(runtime.identity, { buildId: descriptor.buildId, nodeVersion: descriptor.nodeVersion, libuvVersion: descriptor.libuvVersion, sha256: descriptor.assets.node.sha256 });
    assert.deepEqual((await readFile(runtime.nodePath)), files.get('node.exe'));
    assert.deepEqual((await (await import('node:fs/promises')).readdir(path.join(cache, cacheLeafName(descriptor)))).sort(), ['LICENSE', 'build.json', 'node.exe']);

    const ready = await portableNodeStatus('portable', cache, descriptor);
    assert.equal(ready.ready, true);
    assert.equal(ready.supported, true);
    assert.equal(ready.sha256, descriptor.assets.node.sha256);

    const unavailable: PortableNodeDescriptor = { ...descriptor, available: false, unavailableReason: 'not pinned' };
    const system = await portableNodeStatus('system', cache, unavailable);
    assert.equal(system.ready, false);
    assert.equal(system.error?.code, 'PORTABLE_NODE_DESCRIPTOR_UNAVAILABLE');
  });
});

test('portable runtime rejects altered, missing, linked, and unexpected cache entries before use', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async cache => {
    const { descriptor, files } = fixtureDescriptor();
    const runtime = await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files) });
    await writeFile(runtime.nodePath, Buffer.alloc(files.get('node.exe')!.length, 7));
    await assert.rejects(resolvePortableNodeRuntime(cache, descriptor), error =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'PORTABLE_NODE_HASH_MISMATCH' &&
      error instanceof Error && /Remove the affected portable Node build cache manually/u.test(error.message));

    await rm(path.join(cache, cacheLeafName(descriptor)), { recursive: true, force: true });
    await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files) });
    const leaf = path.join(cache, cacheLeafName(descriptor));
    const hardLink = path.join(cache, 'node-hard-link.exe');
    await link(path.join(leaf, 'node.exe'), hardLink);
    await rejectsCode(resolvePortableNodeRuntime(cache, descriptor), 'UNSAFE_PORTABLE_NODE_CACHE');
    await unlink(hardLink);
    await writeFile(path.join(leaf, 'extra.dll'), 'unexpected runtime payload');
    await rejectsCode(resolvePortableNodeRuntime(cache, descriptor), 'UNSAFE_PORTABLE_NODE_CACHE');

    await rm(leaf, { recursive: true, force: true });
    await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files) });
    await unlink(path.join(cache, cacheLeafName(descriptor), 'LICENSE'));
    await rejectsCode(resolvePortableNodeRuntime(cache, descriptor), 'PORTABLE_NODE_NOT_PREPARED');
  });
});

test('portable preparation rejects a reparse-point ancestor before it can create outside the cache', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await mkdir(shortTemporaryRoot, { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(path.join(shortTemporaryRoot, 'parent-'));
  const outside = await mkdtemp(path.join(shortTemporaryRoot, 'outside-'));
  try {
    const { descriptor, files } = fixtureDescriptor();
    const link = path.join(parent, 'cache-link');
    await symlink(outside, link, 'junction');
    await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: path.join(link, 'cache'), descriptor, fetch: assetFetch(files) }), 'UNSAFE_PORTABLE_NODE_CACHE');
    await assert.rejects(lstat(path.join(outside, 'cache')), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    await rm(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test('portable preparation recovers a verified dead lock, waits for a live lock, and coalesces concurrent downloads', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async cache => {
    const { descriptor, files } = fixtureDescriptor();
    const lock = path.join(cache, `.portable-node-${descriptor.buildId}-${descriptor.assets.node.sha256}.lock`);
    await writeFile(lock, JSON.stringify({ pid: 2_147_483_647 }));
    await preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files) });
    await assert.rejects(lstat(lock), { code: 'ENOENT' });

    await rm(path.join(cache, cacheLeafName(descriptor)), { recursive: true, force: true });
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    let liveLockRequests = 0;
    const pending = preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: assetFetch(files, () => { liveLockRequests++; }) });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(liveLockRequests, 0, 'a live owner must retain its lock');
    await unlink(lock);
    await pending;

    await rm(path.join(cache, cacheLeafName(descriptor)), { recursive: true, force: true });
    let requests = 0;
    const fetch = assetFetch(files, () => { requests++; });
    await Promise.all([
      preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch }),
      preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch }),
    ]);
    assert.equal(requests, 3, 'only the lock holder downloads the three pinned assets');
  });
});

test('portable preparation rejects redirect hosts and oversized downloads without installing a cache', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  await cacheFixture(async cache => {
    const { descriptor, files } = fixtureDescriptor();
    const redirect: typeof globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/node.exe' } });
    await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: redirect }), 'PORTABLE_NODE_DOWNLOAD_REJECTED');
    await assert.rejects(lstat(path.join(cache, cacheLeafName(descriptor))), { code: 'ENOENT' });

    const oversized: typeof globalThis.fetch = async input => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      const name = url.pathname.split('/').at(-1)!;
      const contents = files.get(name)!;
      return new Response(Buffer.concat([contents, Buffer.from('x')]), { status: 200 });
    };
    await rejectsCode(preparePortableNodeRuntime({ cacheDirectory: cache, descriptor, fetch: oversized }), 'PORTABLE_NODE_DOWNLOAD_REJECTED');
    await assert.rejects(lstat(path.join(cache, cacheLeafName(descriptor))), { code: 'ENOENT' });
  });
});
