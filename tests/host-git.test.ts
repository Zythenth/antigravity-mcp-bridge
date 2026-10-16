import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, type Writable } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  git,
  resolveGitExecutable,
  buildHostGitEnv,
  buildSafeGitPath,
  ensureGitVersionAdmission,
  _resetGitAdmissionCache,
} from '../src/host-git.js';
import {
  createProjectCopy,
  discardProjectCopy,
  enumerateGitCandidates,
  verifyManagedCopy,
  previewProjectCopy,
  managedGit,
  getFenceMarkerPath,
} from '../src/isolation.js';
import { collectArtifacts, readArtifact } from '../src/artifacts.js';
import { BridgeError } from '../src/types.js';

if (process.platform === 'win32') {
  const dir = fileURLToPath(new URL('../../tests/.git-runtime/bin', import.meta.url));
  const gitExe = path.join(dir, 'git.exe');
  if (existsSync(gitExe)) {
    process.env.PATH = dir + path.delimiter + (process.env.PATH ?? '');
    process.env.GIT_EXEC_PATH = dir;
  }
}

async function createTempRepo(prefix = 'agy-host-git-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@invalid.local'], { cwd: dir });
  return dir;
}

test('host-git: core.fsmonitor cannot run from project configuration', async () => {
  const dir = await createTempRepo();
  const marker = path.join(os.tmpdir(), `fsmonitor-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const scriptPath = path.join(dir, 'fsmonitor-probe.mjs');
  await writeFile(
    scriptPath,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'fsmonitor executed'); process.stdout.write('\\0');\n`
  );

  try {
    // 1. Seed and commit a synthetic file BEFORE configuring fsmonitor hook so index is non-empty
    await writeFile(path.join(dir, 'seed.txt'), 'initial seeded content\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial seed'], { cwd: dir });

    // 2. Configure the core.fsmonitor hook
    const nodeCmd = `"${process.execPath}" "${scriptPath}"`;
    execFileSync('git', ['config', 'core.fsmonitor', nodeCmd], { cwd: dir });

    // Exercise status and add with a populated index.

    // 4. Safe git helper consults status/add and must suppress fsmonitor
    await writeFile(path.join(dir, 'seed.txt'), 'modified seed content\n');
    const statusOutput = await git(dir, ['status']);
    assert.ok(statusOutput instanceof Buffer);
    assert.equal(existsSync(marker), false, 'Safe git helper must suppress project core.fsmonitor on status');

    const addOutput = await git(dir, ['add', 'seed.txt']);
    assert.ok(addOutput instanceof Buffer);
    assert.equal(existsSync(marker), false, 'Safe git helper must suppress project core.fsmonitor on add');

    // 5. Caller attempting to override core.fsmonitor via -c, attached -c, or --config-env is stripped
    await git(dir, ['-c', `Core.FSMonitor=${nodeCmd}`, 'status']);
    assert.equal(existsSync(marker), false, 'Mixed-case -c Core.FSMonitor override must be stripped');

    await git(dir, ['-c', 'core.fsmonitor', 'status']);
    assert.equal(existsSync(marker), false, 'Bare key -c core.fsmonitor override must be stripped');

    await git(dir, [`-cCore.FSMonitor=${nodeCmd}`, 'status']);
    assert.equal(existsSync(marker), false, 'Attached -cCore.FSMonitor override must be stripped');

    await git(dir, ['--config-env', 'core.fsmonitor=NONEXISTENT_VAR', 'status']);
    assert.equal(existsSync(marker), false, '--config-env core.fsmonitor override must be stripped');
  } finally {
    await rm(marker, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: executable resolution rejects candidates inside cwd and permits outside symlinks', async () => {
  const dir = await createTempRepo();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'agy-outside-git-'));
  const hijackMarker = path.join(os.tmpdir(), `hijack-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const isWindows = process.platform === 'win32';
  const fakeExeName = isWindows ? 'git.exe' : 'git';
  const fakeExePath = path.join(dir, fakeExeName);

  try {
    if (isWindows) {
      const systemWhere = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
      if (existsSync(systemWhere)) {
        await copyFile(systemWhere, fakeExePath);
      } else {
        await copyFile(process.execPath, fakeExePath);
      }
    } else {
      await writeFile(
        fakeExePath,
        `#!/bin/sh\necho "hijacked" > "${hijackMarker}"\nexit 0\n`,
        { mode: 0o755 }
      );
    }

    // 1. Direct resolver check with PATH starting with cwd or relative entry
    const poisonedPath = `${dir}${path.delimiter}.${path.delimiter}${process.env.PATH ?? ''}`;
    const resolved = await resolveGitExecutable(dir, poisonedPath);
    assert.notEqual(
      path.resolve(resolved).toLowerCase(),
      path.resolve(fakeExePath).toLowerCase(),
      'Resolved executable must not be inside cwd'
    );
    assert.ok(path.isAbsolute(resolved), 'Resolved executable must be absolute');

    // 2. Resolver check when PATH only contains cwd
    await assert.rejects(
      resolveGitExecutable(dir, dir),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED'
    );

    const dotdotDirectory = path.join(dir, '..tools');
    await mkdir(dotdotDirectory);
    await copyFile(fakeExePath, path.join(dotdotDirectory, fakeExeName));
    await assert.rejects(resolveGitExecutable(dir, dotdotDirectory), { code: 'GIT_OPERATION_FAILED' });

    // 3. Symlink pointing outside cwd is permitted; symlink pointing inside cwd is rejected
    if (!isWindows) {
      const outsideExe = path.join(outsideDir, 'git');
      await writeFile(outsideExe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const outsideSymlinkDir = await mkdtemp(path.join(os.tmpdir(), 'agy-symlink-git-'));
      try {
        const outsideSymlink = path.join(outsideSymlinkDir, 'git');
        await symlink(outsideExe, outsideSymlink);

        const foundSymlink = await resolveGitExecutable(dir, outsideSymlinkDir);
        assert.equal(path.resolve(foundSymlink), path.resolve(outsideSymlink));

        // Symlink pointing to target inside cwd must be rejected
        const insideTarget = path.join(dir, 'real-target');
        await writeFile(insideTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const evilSymlink = path.join(outsideSymlinkDir, 'evil-git');
        await symlink(insideTarget, evilSymlink);
        // Rename evilSymlink to git to test resolution
        await rm(outsideSymlink, { force: true });
        await symlink(insideTarget, outsideSymlink);
        await assert.rejects(
          resolveGitExecutable(dir, outsideSymlinkDir),
          (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED'
        );
      } finally {
        await rm(outsideSymlinkDir, { recursive: true, force: true });
      }
    }

    // 4. Invoking git inside cwd executes trusted git, never cwd fake
    const versionOutput = await git(dir, ['version'], undefined, [0], {
      env: { ...process.env, PATH: poisonedPath },
    });
    assert.ok(versionOutput.toString('utf8').includes('git version'));
    await writeFile(path.join(dir, 'safe.txt'), 'synthetic selected source');
    const previousPath = process.env.PATH;
    let copy;
    try {
      process.env.PATH = poisonedPath;
      copy = await createProjectCopy(dir, ['safe.txt']);
      assert.deepEqual(copy.includedFiles, ['safe.txt']);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (copy) await discardProjectCopy(copy);
    }
    assert.equal(existsSync(hijackMarker), false, 'Cwd executable must not be executed');
  } finally {
    await rm(hijackMarker, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: global clean filter cannot execute on snapshot add', async () => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'agy-fake-home-'));
  const marker = path.join(os.tmpdir(), `clean-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const filterScript = path.join(fakeHome, 'filter.mjs');
  await writeFile(filterScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'clean executed');\n`);

  const repo = await createTempRepo();
  let projectCopy;

  try {
    const cleanCmd = `"${process.execPath}" "${filterScript}"`;
    const gitconfigContent = `[filter "synthetic_probe"]\n  clean = ${JSON.stringify(cleanCmd)}\n  required = true\n`;
    await writeFile(path.join(fakeHome, '.gitconfig'), gitconfigContent);

    await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=synthetic_probe\n');
    await writeFile(path.join(repo, 'sample.txt'), 'content requiring baseline\n');

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      projectCopy = await createProjectCopy(repo);
      assert.ok(projectCopy, 'Project copy should succeed');
      assert.equal(existsSync(marker), false, 'Global clean filter marker must not be written');
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
      else delete process.env.USERPROFILE;
    }
  } finally {
    if (projectCopy) {
      await discardProjectCopy(projectCopy);
    }
    await rm(marker, { force: true });
    await rm(fakeHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('host-git: effective core.excludesfile and default XDG ignores are preserved', async () => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'agy-fake-home-'));
  const repo = await createTempRepo();

  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origXdg = process.env.XDG_CONFIG_HOME;

  try {
    const globalIgnoreFile = path.join(fakeHome, 'custom-global-ignore');
    await writeFile(globalIgnoreFile, '*.global_secret\n');

    await writeFile(
      path.join(fakeHome, '.gitconfig'),
      `[core]\n  excludesfile = "${globalIgnoreFile.replaceAll('\\', '/')}"\n`
    );

    await writeFile(path.join(repo, 'normal.txt'), 'regular content\n');
    await writeFile(path.join(repo, 'leaked.global_secret'), 'confidential\n');

    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    const candidates = await enumerateGitCandidates(repo);
    assert.ok(candidates.includes('normal.txt'));
    assert.equal(candidates.includes('leaked.global_secret'), false, 'core.excludesfile must be honored');

    // Now test default XDG ignore (~/.config/git/ignore)
    const xdgDir = path.join(fakeHome, '.config', 'git');
    await mkdir(xdgDir, { recursive: true });
    await writeFile(path.join(xdgDir, 'ignore'), '*.xdg_secret\n');
    await rm(path.join(fakeHome, '.gitconfig'), { force: true });

    await writeFile(path.join(repo, 'leaked.xdg_secret'), 'confidential xdg\n');

    delete process.env.XDG_CONFIG_HOME;

    const candidatesXdg = await enumerateGitCandidates(repo);
    assert.ok(candidatesXdg.includes('normal.txt'));
    assert.equal(candidatesXdg.includes('leaked.xdg_secret'), false, 'Default XDG ignore must be honored');
    await writeFile(path.join(fakeHome, '.gitconfig'), '[core]\n  excludesfile = \"\"\n');
    const explicitEmpty = await enumerateGitCandidates(repo);
    assert.ok(explicitEmpty.includes('leaked.xdg_secret'), 'An explicit empty excludesFile must disable the default');
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;

    await rm(fakeHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('host-git: dangerous environment variables are stripped and safe enum is preserved', () => {
  const poisonedSource: NodeJS.ProcessEnv = {
    PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
    NODE_OPTIONS: '--inspect=9229',
    LD_PRELOAD: '/tmp/evil.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    GIT_EXEC_PATH: '/tmp/evil-git',
    GIT_CONFIG_PARAMETERS: 'core.fsmonitor=evil',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SSH_ASKPASS: '/tmp/askpass',
    GIT_ASKPASS: '/tmp/askpass',
    GITHUB_TOKEN: 'synthetic-test-token-value',
    HTTP_PROXY: 'http://user:pass@proxy.local',
    GIT_DEFAULT_REF_FORMAT: 'reftable',
    HOME: 'C:\\Users\\test',
    LANG: 'en_US.UTF-8',
    RANDOM_SECRET_KEY: 'secret1234',
  };

  const filtered = buildHostGitEnv(poisonedSource, false);

  assert.equal(filtered.NODE_OPTIONS, undefined);
  assert.equal(filtered.LD_PRELOAD, undefined);
  assert.equal(filtered.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(filtered.GIT_EXEC_PATH, undefined);
  assert.equal(filtered.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(filtered.SSH_AUTH_SOCK, undefined);
  assert.equal(filtered.SSH_ASKPASS, undefined);
  assert.equal(filtered.GIT_ASKPASS, undefined);
  assert.equal(filtered.GITHUB_TOKEN, undefined);
  assert.equal(filtered.HTTP_PROXY, undefined);
  assert.equal(filtered.RANDOM_SECRET_KEY, undefined);

  assert.equal(filtered.GIT_DEFAULT_REF_FORMAT, 'reftable');
  assert.equal(filtered.GIT_TERMINAL_PROMPT, '0');
  assert.equal(filtered.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(filtered.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : os.devNull);
  assert.equal(filtered.HOME, 'C:\\Users\\test');
  assert.equal(filtered.LANG, 'en_US.UTF-8');

  // Verify non-harmless ref format is stripped
  const invalidRefFormat = buildHostGitEnv({ ...poisonedSource, GIT_DEFAULT_REF_FORMAT: 'invalid; injection' });
  assert.equal(invalidRefFormat.GIT_DEFAULT_REF_FORMAT, undefined);
});

test('host-git: stdin failure settles with GIT_OPERATION_FAILED and timeout is bounded with deterministic fixture', async t => {
  const dir = await createTempRepo();

  try {
    // 1. Timeout validation: non-positive, non-finite or invalid timeout throws
    await assert.rejects(
      git(dir, ['version'], undefined, [0], { timeoutMs: -1 }),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED' && err.message.includes('Invalid timeoutMs')
    );
    await assert.rejects(
      git(dir, ['version'], undefined, [0], { timeoutMs: 0 }),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED' && err.message.includes('Invalid timeoutMs')
    );
    await assert.rejects(
      git(dir, ['version'], undefined, [0], { timeoutMs: Number.NaN }),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED' && err.message.includes('Invalid timeoutMs')
    );

    // 2. Stdin interruption / stream communication error
    await assert.rejects(
      git(dir, ['version'], Buffer.alloc(5 * 1024 * 1024)),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED'
    );

    // 3. Deterministic timeout with injected spawn control fixture
    function mockHangingSpawn(): ChildProcessWithoutNullStreams {
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      child.stdout = new PassThrough() as unknown as ChildProcessWithoutNullStreams['stdout'];
      child.stderr = new PassThrough() as unknown as ChildProcessWithoutNullStreams['stderr'];
      child.stdin = new PassThrough() as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
      Object.assign(child, { pid: undefined, exitCode: null, signalCode: null });
      child.kill = () => {
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    }

    const watchdog = setInterval(() => {}, 1000);
    t.after(() => clearInterval(watchdog));
    const start = Date.now();
    await assert.rejects(
      git(dir, ['version'], undefined, [0], {
        timeoutMs: 25,
        spawnImpl: mockHangingSpawn as unknown as typeof import('node:child_process').spawn,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('timed out after 25ms'), `Expected timeout message, got: ${err.message}`);
        return true;
      }
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Mock timeout took ${elapsed}ms, expected ~25ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: binary NUL-safe output and allowed exit codes behavior', async () => {
  const dir = await createTempRepo();

  try {
    // 1. Binary output with NUL bytes (using --others so untracked files are returned)
    await writeFile(path.join(dir, 'file1.txt'), 'hello');
    await writeFile(path.join(dir, 'file2.txt'), 'world');
    const bytes = await git(dir, ['ls-files', '--others', '-z']);
    assert.ok(Buffer.isBuffer(bytes));
    assert.ok(bytes.includes(0), 'ls-files --others -z must include NUL bytes');
    const names = bytes.toString('utf8').split('\0').filter(Boolean);
    assert.ok(names.includes('file1.txt'));
    assert.ok(names.includes('file2.txt'));
    await writeFile(path.join(dir, '-ccore.fsmonitor'), 'literal path');
    const literalPath = await git(dir, ['ls-files', '--others', '-z', '--', '-ccore.fsmonitor']);
    assert.deepEqual(literalPath, Buffer.from('-ccore.fsmonitor\0'), 'Config-looking filenames must remain literal after the command');

    await writeFile(path.join(dir, '--git-dir=literal'), 'literal git-dir');
    await writeFile(path.join(dir, '--work-tree=literal'), 'literal work-tree');
    const literalScopePaths = await git(dir, ['ls-files', '--others', '-z', '--', '--git-dir=literal', '--work-tree=literal']);
    assert.deepEqual(
      literalScopePaths.toString('utf8').split('\0').filter(Boolean).sort(),
      ['--git-dir=literal', '--work-tree=literal'].sort(),
      'Literal --git-dir=literal and --work-tree=literal must remain literal filenames and not redirect config lookup'
    );

    // 2. Allowed exit codes (check-ignore returns 1 when not ignored)
    const checkIgnoreOutput = await git(
      dir,
      ['check-ignore', '--no-index', 'file1.txt'],
      undefined,
      [0, 1]
    );
    assert.ok(Buffer.isBuffer(checkIgnoreOutput));
    assert.equal(checkIgnoreOutput.length, 0);

    // 3. Disallowed exit code rejects
    await assert.rejects(
      git(dir, ['check-ignore', '--no-index', 'file1.txt'], undefined, [0]),
      (err: unknown) => err instanceof BridgeError && err.code === 'GIT_OPERATION_FAILED'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: explicit truncation marker suppresses overlong stderr without tail leakage', async () => {
  const dir = await createTempRepo();

  function mockOverlongStderrSpawn(): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
    child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
    child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
    Object.assign(child, { pid: undefined, exitCode: 1, signalCode: null });
    child.kill = () => true;

    setImmediate(() => {
      // A cutoff through sensitive text must suppress the entire diagnostic.
      stderr.write('E'.repeat(3990) + 'synthetic-sensitive-fragment');
      stderr.end();
      child.emit('close', 1, null);
    });

    return child;
  }

  try {
    await assert.rejects(
      git(dir, ['version'], undefined, [0], {
        spawnImpl: mockOverlongStderrSpawn as unknown as typeof import('node:child_process').spawn,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('... [diagnostic truncated]'), `Expected truncation marker, got: ${err.message}`);
        assert.equal(err.message, '... [diagnostic truncated]');
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: child PATH rebuilt with absolute entries only, excluding cwd and project roots', async () => {
  const dir = await createTempRepo();
  const excludedProject = await createTempRepo('agy-excluded-proj-');

  try {
    const isWindows = process.platform === 'win32';
    const validOutsideDir = await mkdtemp(path.join(os.tmpdir(), 'agy-valid-outside-'));

    try {
      // Input raw PATH with: empty entries, relative entries (., relative/sub), cwd, and excluded project root
      const rawPath = [
        '',
        '.',
        'relative/path',
        dir,
        path.join(dir, 'sub'),
        excludedProject,
        validOutsideDir,
        isWindows ? 'C:\\Windows\\System32' : '/bin',
      ].join(path.delimiter);

      const safePath = await buildSafeGitPath(dir, rawPath, [excludedProject]);
      const entries = safePath.split(path.delimiter).filter(Boolean);

      // Verify all entries in safePath are absolute
      for (const entry of entries) {
        assert.ok(path.isAbsolute(entry), `Entry must be absolute: ${entry}`);
      }

      // Verify cwd and excludedProject are not in safePath
      const lowerEntries = isWindows ? entries.map(e => e.toLowerCase()) : entries;
      const lowerDir = isWindows ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      const lowerExcluded = isWindows ? path.resolve(excludedProject).toLowerCase() : path.resolve(excludedProject);

      assert.equal(lowerEntries.includes(lowerDir), false, 'cwd must be excluded');
      assert.equal(lowerEntries.includes(lowerExcluded), false, 'excluded project must be excluded');
      assert.equal(lowerEntries.some(e => e === '.' || e.startsWith('relative')), false, 'relative entries must be excluded');

      // Verify buildHostGitEnv with safePath sets env.PATH exactly
      const childEnv = buildHostGitEnv(process.env, false, safePath);
      assert.equal(childEnv.PATH, safePath);
    } finally {
      await rm(validOutsideDir, { recursive: true, force: true });
    }
  } finally {
    await rm(excludedProject, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: protected config override forms closed case-insensitively, bare keys, attached -c and --config-env', async () => {
  const dir = await createTempRepo();

  try {
    let capturedArgs: string[] = [];
    const mockSpawn = ((_file: string, args: string[], _options: unknown) => {
      const versionQuery = args.includes('--version');
      const configQuery = args.includes('config');
      if (!versionQuery && !configQuery) capturedArgs = args;
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
      child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
      child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
      Object.assign(child, { pid: undefined, exitCode: 0, signalCode: null });
      child.kill = () => true;
      setImmediate(() => {
        if (versionQuery) stdout.write('git version 2.55.0\n');
        else if (!configQuery) stdout.write('test-output\n');
        stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    // 1. Detached mixed-case, bare key, and hookspath
    await git(
      dir,
      [
        '-c', 'Core.FSMonitor=evil-fsmonitor',
        '-c', 'core.fsmonitor',
        '-c', 'CORE.HOOKSPATH=/evil/hooks',
        '-c', 'user.name=Legitimate Name',
        'status',
      ],
      undefined,
      [0],
      { spawnImpl: mockSpawn }
    );

    assert.ok(!capturedArgs.some(a => a.toLowerCase().includes('evil-fsmonitor')));
    assert.ok(!capturedArgs.some(a => a.toLowerCase().includes('evil/hooks')));
    assert.ok(!capturedArgs.some((a, idx) => a === '-c' && capturedArgs[idx + 1] === 'core.fsmonitor'));
    assert.ok(capturedArgs.includes('user.name=Legitimate Name'), 'Legitimate config must be preserved');

    // 2. Attached forms
    await git(
      dir,
      [
        '-cCore.FSMonitor=evil',
        '-ccore.fsmonitor',
        '-cCORE.HOOKSPATH=evil',
        '-cuser.name=Attached Name',
        'status',
      ],
      undefined,
      [0],
      { spawnImpl: mockSpawn }
    );

    assert.ok(!capturedArgs.some(a => a.toLowerCase().startsWith('-ccore.fsmonitor')));
    assert.ok(!capturedArgs.some(a => a.toLowerCase().startsWith('-ccore.hookspath')));
    assert.ok(capturedArgs.includes('-cuser.name=Attached Name'), 'Legitimate attached config must be preserved');

    // 3. --config-env detached and attached
    await git(
      dir,
      [
        '--config-env', 'core.fsmonitor=EVIL_ENV',
        '--config-env', 'Core.HooksPath=EVIL_ENV',
        '--config-env=core.fsmonitor=EVIL_ENV',
        '--config-env=CORE.HOOKSPATH=EVIL_ENV',
        '--config-env', 'user.name=NAME_ENV',
        '--config-env=user.email=EMAIL_ENV',
        'status',
      ],
      undefined,
      [0],
      { spawnImpl: mockSpawn }
    );

    assert.deepEqual(capturedArgs.filter(a => /core\.fsmonitor/i.test(a)), ['core.fsmonitor=false']);
    assert.deepEqual(capturedArgs.filter(a => /core\.hookspath/i.test(a)), ['core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : os.devNull)]);
    assert.ok(capturedArgs.includes('user.name=NAME_ENV'), 'Legitimate --config-env detached must be preserved');
    assert.ok(capturedArgs.includes('--config-env=user.email=EMAIL_ENV'), 'Legitimate --config-env attached must be preserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: minimum Git 2.32 admission enforced with diagnostic and bounded cache', async () => {
  const dir = await createTempRepo();

  try {
    _resetGitAdmissionCache();

    function makeMockVersionSpawn(versionString: string) {
      return ((_file: string, _args: string[], _options: unknown) => {
        const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
        child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
        child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
        Object.assign(child, { pid: undefined, exitCode: 0, signalCode: null });
        child.kill = () => true;
        setImmediate(() => {
          stdout.write(`git version ${versionString}\n`);
          stdout.end();
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as typeof import('node:child_process').spawn;
    }

    // 1. Version 2.31.1 fails admission with explicit diagnostic mentioning GIT_CONFIG_GLOBAL
    await assert.rejects(
      ensureGitVersionAdmission('git', makeMockVersionSpawn('2.31.1')),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('Git 2.32.0 or newer is required'));
        assert.ok(err.message.includes('GIT_CONFIG_GLOBAL'));
        return true;
      }
    );

    // 2. Version 1.8.3 fails admission
    await assert.rejects(
      ensureGitVersionAdmission('git', makeMockVersionSpawn('1.8.3.1')),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('Git 2.32.0 or newer is required'));
        return true;
      }
    );

    // 3. Version 2.32.0 passes admission
    await ensureGitVersionAdmission('git', makeMockVersionSpawn('2.32.0'));

    // 4. Version 2.45.1 passes admission
    await ensureGitVersionAdmission('git', makeMockVersionSpawn('2.45.1.windows.1'));

    // 5. Project operation with sub-2.32 version fails closed
    await assert.rejects(
      git(dir, ['status'], undefined, [0], {
        spawnImpl: makeMockVersionSpawn('2.31.1'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('Git 2.32.0 or newer is required'));
        return true;
      }
    );
  } finally {
    _resetGitAdmissionCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git: separated value-taking options do not masquerade as command', async () => {
  const dir = await createTempRepo();

  try {
    _resetGitAdmissionCache();

    function makeMockVersionSpawn(versionString: string) {
      return ((_file: string, _args: string[], _options: unknown) => {
        const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
        child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
        child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
        Object.assign(child, { pid: undefined, exitCode: 0, signalCode: null });
        child.kill = () => true;
        setImmediate(() => {
          stdout.write(`git version ${versionString}\n`);
          stdout.end();
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as typeof import('node:child_process').spawn;
    }

    // 1. -C version status: 'version' is argument to -C, command is 'status'. Version admission must run!
    await assert.rejects(
      git(dir, ['-C', 'version', 'status'], undefined, [0], {
        spawnImpl: makeMockVersionSpawn('2.31.1'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('Git 2.32.0 or newer is required'));
        return true;
      }
    );

    // 2. --work-tree version status: command is 'status', not 'version'
    await assert.rejects(
      git(dir, ['--work-tree', 'version', 'status'], undefined, [0], {
        spawnImpl: makeMockVersionSpawn('2.31.1'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_OPERATION_FAILED');
        assert.ok(err.message.includes('Git 2.32.0 or newer is required'));
        return true;
      }
    );

    // 3. Capturing spawn to verify scope collection and exclude lookup for separated options
    let capturedArgs: string[][] = [];
    const mockCapturingSpawn = ((_file: string, args: string[], _options: unknown) => {
      capturedArgs.push(args);
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
      child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
      child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
      Object.assign(child, { pid: undefined, exitCode: 0, signalCode: null });
      child.kill = () => true;
      setImmediate(() => {
        if (args.includes('--version')) stdout.write('git version 2.40.0\n');
        stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    // --git-dir config status: command is 'status', not 'config'.
    // Exclude lookup must NOT be skipped, and scope must include separated --git-dir config!
    capturedArgs = [];
    await git(dir, ['--git-dir', 'config', 'status'], undefined, [0], {
      spawnImpl: mockCapturingSpawn,
    });
    const configCall = capturedArgs.find(a => a.includes('config') && a.includes('core.excludesfile'));
    assert.ok(configCall, 'Config lookup must not be skipped when config is an argument to --git-dir');
    assert.ok(configCall.includes('--git-dir') && configCall[configCall.indexOf('--git-dir') + 1] === 'config',
      'Scope must preserve separated global --git-dir option');

    // Filenames after command must NOT be collected into scope
    capturedArgs = [];
    await git(dir, ['status', '--git-dir=literal'], undefined, [0], {
      spawnImpl: mockCapturingSpawn,
    });
    const configCall2 = capturedArgs.find(a => a.includes('config') && a.includes('core.excludesfile'));
    assert.ok(configCall2, 'Config lookup should execute for status');
    assert.ok(!configCall2.some(a => a.includes('--git-dir=literal')),
      'Filename after command must not be added to scope');
  } finally {
    _resetGitAdmissionCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('host-git & isolation: unverified process cleanup rejects with GIT_CLEANUP_UNVERIFIED and fences copy reuse', async () => {
  const dir = await createTempRepo();

  try {
    await writeFile(path.join(dir, 'sample.txt'), 'hello world\n');
    execFileSync('git', ['add', 'sample.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

    function mockUnclosedStreamsSpawn(): ChildProcessWithoutNullStreams {
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
      child.stderr = stderr as unknown as ChildProcessWithoutNullStreams['stderr'];
      child.stdin = stdin as unknown as Writable & ChildProcessWithoutNullStreams['stdin'];
      Object.assign(child, { pid: undefined, exitCode: null, signalCode: null });
      child.kill = () => false;
      return child;
    }

    // 1. Direct git call with unclosed streams rejects with GIT_CLEANUP_UNVERIFIED upon grace expiration
    await assert.rejects(
      git(dir, ['status'], undefined, [0], {
        timeoutMs: 25,
        shutdownGraceMs: 50,
        spawnImpl: mockUnclosedStreamsSpawn as unknown as typeof import('node:child_process').spawn,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_CLEANUP_UNVERIFIED');
        assert.ok(err.message.includes('termination grace expired'));
        return true;
      }
    );

    // 2. ensureGitVersionAdmission preserves GIT_CLEANUP_UNVERIFIED
    _resetGitAdmissionCache();
    await assert.rejects(
      ensureGitVersionAdmission('git', mockUnclosedStreamsSpawn as unknown as typeof import('node:child_process').spawn),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'GIT_CLEANUP_UNVERIFIED');
        return true;
      }
    );

    // 3. Managed project copy writes fence marker on GIT_CLEANUP_UNVERIFIED and fences copy reuse
    const copy = await createProjectCopy(dir, ['sample.txt']);
    try {
      await assert.rejects(
        managedGit(copy, copy.copyDirectory, ['status'], undefined, [0], {
          timeoutMs: 25,
          shutdownGraceMs: 50,
          spawnImpl: mockUnclosedStreamsSpawn as unknown as typeof import('node:child_process').spawn,
        }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'GIT_CLEANUP_UNVERIFIED');
          return true;
        }
      );

      // Verify fence marker was written
      const markerPath = getFenceMarkerPath(copy);
      assert.ok(existsSync(markerPath), 'Fence marker must exist in gitDirectory');
      const markerContent = JSON.parse(await readFile(markerPath, 'utf8'));
      assert.deepEqual(markerContent, { code: 'GIT_CLEANUP_UNVERIFIED', version: 1 });

      // Verify copy refusal across managed operations
      await assert.rejects(verifyManagedCopy(copy), { code: 'GIT_CLEANUP_UNVERIFIED' });
      await assert.rejects(managedGit(copy, copy.copyDirectory, ['status']), { code: 'GIT_CLEANUP_UNVERIFIED' });
      await assert.rejects(previewProjectCopy(copy), { code: 'GIT_CLEANUP_UNVERIFIED' });
      await assert.rejects(collectArtifacts(copy, ['sample.txt']), { code: 'GIT_CLEANUP_UNVERIFIED' });
      await assert.rejects(readArtifact(copy, { path: 'sample.txt', sha256: 'a'.repeat(64), bytes: 10 }, 'a'.repeat(64)), { code: 'GIT_CLEANUP_UNVERIFIED' });
      await assert.rejects(discardProjectCopy(copy), { code: 'GIT_CLEANUP_UNVERIFIED' });

      // Restored copy record with same gitDirectory is also fenced
      const restoredCopy = { ...copy };
      await assert.rejects(verifyManagedCopy(restoredCopy), { code: 'GIT_CLEANUP_UNVERIFIED' });

      // Fixture may remove its own marker before cleanup
      await rm(markerPath, { force: true });
      await discardProjectCopy(copy);
    } catch (err) {
      // Ensure cleanup in case of unexpected failure
      await rm(getFenceMarkerPath(copy), { force: true });
      await discardProjectCopy(copy).catch(() => {});
      throw err;
    }
  } finally {
    _resetGitAdmissionCache();
    await rm(dir, { recursive: true, force: true });
  }
});
