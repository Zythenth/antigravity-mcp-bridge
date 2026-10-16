import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface HarnessResponse {
  success: boolean;
  error?: string;
  environment?: Record<string, string>;
}

async function harnessFixture<T>(run: (context: {
  temp: string;
  copy: string;
  runtime: string;
  scratch: string;
  outside: string;
  systemRoot: string;
  invoke: (environment: Record<string, string>, maxFiles?: number) => HarnessResponse;
}) => Promise<T>): Promise<T> {
  const temp = await realpath(os.tmpdir());
  const workDir = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-git-env-test-')));
  const copy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
  const runtime = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-')));
  const scratch = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-scratch-')));
  const outside = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-outside-')));
  const directories: Array<[string, string]> = [
    [workDir, 'agy-mcp-git-env-test-'],
    [copy, 'agy-mcp-copy-'],
    [runtime, 'agy-mcp-runtime-'],
    [scratch, 'agy-mcp-scratch-'],
    [outside, 'agy-mcp-outside-'],
  ];

  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const harnessCs = path.resolve('tests/windows-git-environment-harness.cs');
    const runnerCs = path.resolve('native/windows-test-runner.cs');
    const harnessExe = path.join(workDir, 'harness.exe');
    const compiler = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

    execFileSync(compiler, [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/main:GitEnvironmentHarness',
      '/r:System.Web.Extensions.dll',
      '/out:' + harnessExe,
      harnessCs,
      runnerCs,
    ], { windowsHide: true, encoding: 'utf8' });

    const aliases = [
      { kind: 'copy', physicalRoot: copy, aliasRoot: 'X:\\' },
      { kind: 'runtime', physicalRoot: runtime, aliasRoot: 'Y:\\' },
      { kind: 'scratch', physicalRoot: scratch, aliasRoot: 'Z:\\' },
    ];

    const invoke = (environment: Record<string, string>, maxFiles = 10000): HarnessResponse => {
      const reqFile = path.join(workDir, 'req-' + randomUUID() + '.json');
      const reqData = JSON.stringify({ environment, aliases, maxFiles, cwd: copy });
      writeFileSync(reqFile, reqData, { flag: 'wx', encoding: 'utf8' });
      const stdout = execFileSync(harnessExe, [reqFile], { encoding: 'utf8', windowsHide: true });
      return JSON.parse(stdout.trim()) as HarnessResponse;
    };

    return await run({ temp, copy, runtime, scratch, outside, systemRoot, invoke });
  } finally {
    for (const [dir, prefix] of directories) {
      assert.equal(path.dirname(dir), temp);
      assert.ok(path.basename(dir).startsWith(prefix));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

test('C# ProjectEnvironment preserves only owned runtime PATH entries and exact System32', { skip: process.platform !== 'win32' }, async () => {
  await harnessFixture(async ({ runtime, outside, systemRoot, invoke }) => {
    const runtimeSubdir = path.join(runtime, 'git', 'bin');
    const runtimeEvilPrefix = path.join(path.dirname(runtime), path.basename(runtime) + '-evil');
    const system32 = path.join(systemRoot, 'System32');
    const system32Evil = path.join(systemRoot, 'System32evil');
    const privateDir = path.join(outside, 'secret');
    const uncPath = '\\\\remote-server\\share\\bin';
    const traversalDir = path.join(runtime, '..', 'escaped');

    const rawPath = [
      runtimeEvilPrefix,
      system32Evil,
      privateDir,
      uncPath,
      traversalDir,
      runtimeSubdir,
      runtimeSubdir, // duplicate
      system32, // System32 in input
    ].join(';');

    const res = invoke({
      PATH: rawPath,
      SystemRoot: systemRoot,
    });

    assert.equal(res.success, true);
    const projectedPath = res.environment?.PATH || '';
    const entries = projectedPath.split(';');

    // 1. RuntimeRoot is first
    assert.equal(entries[0], 'Y:\\');

    // 2. Subdirectory inside runtime mapped to alias
    assert.ok(entries.includes('Y:\\git\\bin'));

    // 3. System32 is last
    assert.equal(entries[entries.length - 1], system32);

    // 4. Exactly 3 entries (runtime, runtimeSubdir, system32)
    assert.deepEqual(entries, ['Y:\\', 'Y:\\git\\bin', system32]);

    // 5. Hostile and unowned entries omitted
    assert.ok(!projectedPath.includes('-evil'));
    assert.ok(!projectedPath.includes('System32evil'));
    assert.ok(!projectedPath.includes('secret'));
    assert.ok(!projectedPath.includes('remote-server'));
    assert.ok(!projectedPath.includes('escaped'));
    assert.ok(!projectedPath.toLowerCase().includes(runtime.toLowerCase())); // physical source never exposed
  });
});

test('C# ProjectEnvironment validates and projects GIT_EXEC_PATH inside runtime root', { skip: process.platform !== 'win32' }, async () => {
  await harnessFixture(async ({ runtime, outside, invoke }) => {
    // 1. Hostile outside GIT_EXEC_PATH rejected
    const outsideGit = invoke({ GIT_EXEC_PATH: path.join(outside, 'bin') });
    assert.equal(outsideGit.success, false);
    assert.match(outsideGit.error || '', /GIT_EXEC_PATH must be located inside the runtime directory/i);

    // 2. Sibling prefix GIT_EXEC_PATH rejected
    const evilPrefixGit = invoke({ GIT_EXEC_PATH: path.join(path.dirname(runtime), path.basename(runtime) + '-evil') });
    assert.equal(evilPrefixGit.success, false);
    assert.match(evilPrefixGit.error || '', /GIT_EXEC_PATH must be located inside the runtime directory/i);

    // 3. UNC GIT_EXEC_PATH rejected
    const uncGit = invoke({ GIT_EXEC_PATH: '\\\\remote\\git\\bin' });
    assert.equal(uncGit.success, false);
    assert.match(uncGit.error || '', /GIT_EXEC_PATH must be a local absolute path/i);

    // 4. Valid runtime GIT_EXEC_PATH projected to alias
    const validGit = invoke({ GIT_EXEC_PATH: path.join(runtime, 'git', 'bin') });
    assert.equal(validGit.success, true);
    assert.equal(validGit.environment?.GIT_EXEC_PATH, 'Y:\\git\\bin');
  });
});

test('C# ProjectEnvironment validates and projects GIT_CONFIG_GLOBAL inside scratch root', { skip: process.platform !== 'win32' }, async () => {
  await harnessFixture(async ({ scratch, outside, invoke }) => {
    // 1. Outside host GIT_CONFIG_GLOBAL rejected
    const outsideConfig = invoke({ GIT_CONFIG_GLOBAL: path.join(outside, '.gitconfig') });
    assert.equal(outsideConfig.success, false);
    assert.match(outsideConfig.error || '', /GIT_CONFIG_GLOBAL must be located inside the scratch directory/i);

    // 2. Sibling prefix GIT_CONFIG_GLOBAL rejected
    const evilPrefixConfig = invoke({ GIT_CONFIG_GLOBAL: path.join(path.dirname(scratch), path.basename(scratch) + '-evil', '.gitconfig') });
    assert.equal(evilPrefixConfig.success, false);
    assert.match(evilPrefixConfig.error || '', /GIT_CONFIG_GLOBAL must be located inside the scratch directory/i);

    // 3. UNC GIT_CONFIG_GLOBAL rejected
    const uncConfig = invoke({ GIT_CONFIG_GLOBAL: '\\\\remote\\share\\.gitconfig' });
    assert.equal(uncConfig.success, false);
    assert.match(uncConfig.error || '', /GIT_CONFIG_GLOBAL must be a local absolute path/i);

    // 4. Valid scratch GIT_CONFIG_GLOBAL projected to alias
    const validConfig = invoke({ GIT_CONFIG_GLOBAL: path.join(scratch, '.gitconfig') });
    assert.equal(validConfig.success, true);
    assert.equal(validConfig.environment?.GIT_CONFIG_GLOBAL, 'Z:\\.gitconfig');
  });
});

test('C# ProjectEnvironment injects protected safe.directory entries only when verified GIT_EXEC_PATH is present and strips poisoned configuration', { skip: process.platform !== 'win32' }, async () => {
  await harnessFixture(async ({ copy, runtime, invoke }) => {
    // 1. Without GIT_EXEC_PATH: no safe.directory injected, poison variables not purged or injected
    const withoutGit = invoke({});
    assert.equal(withoutGit.success, true);
    assert.equal(withoutGit.environment?.GIT_CONFIG_COUNT, undefined);
    assert.equal(withoutGit.environment?.GIT_CONFIG_KEY_0, undefined);
    assert.equal(withoutGit.environment?.GIT_CONFIG_VALUE_0, undefined);

    // 2. With GIT_EXEC_PATH (no nested repos): exactly 2 entries (reset empty and exact copy alias)
    const validGitPath = path.join(runtime, 'git', 'bin');
    const withGit = invoke({
      GIT_EXEC_PATH: validGitPath,
      git_config_count: '99',
      GIT_CONFIG_PARAMETERS: "'safe.directory=*'",
      git_config_key_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      git_config_key_99: 'core.autocrlf',
      GIT_CONFIG_VALUE_99: 'false',
    });

    assert.equal(withGit.success, true);
    const env = withGit.environment || {};

    // Poisoned keys removed
    assert.equal(env.git_config_count, undefined);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.git_config_key_0, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.git_config_key_99, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_99, undefined);

    // Exact 2 entries projected (no wildcards)
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_KEY_1, 'safe.directory');
    assert.equal(env.GIT_CONFIG_VALUE_1, 'X:\\');
    assert.equal(env.GIT_CONFIG_KEY_2, undefined);

    // 3. With nested git repository present in copy: exact 3 entries projected
    const nestedDir = path.join(copy, 'submodules', 'nested-repo');
    const nestedGit = path.join(nestedDir, '.git');
    await mkdir(nestedGit, { recursive: true });

    const withNested = invoke({
      GIT_EXEC_PATH: validGitPath,
    });
    assert.equal(withNested.success, true);
    const nestedEnv = withNested.environment || {};

    assert.equal(nestedEnv.GIT_CONFIG_COUNT, '3');
    assert.equal(nestedEnv.GIT_CONFIG_KEY_0, 'safe.directory');
    assert.equal(nestedEnv.GIT_CONFIG_VALUE_0, '');
    assert.equal(nestedEnv.GIT_CONFIG_KEY_1, 'safe.directory');
    assert.equal(nestedEnv.GIT_CONFIG_VALUE_1, 'X:\\');
    assert.equal(nestedEnv.GIT_CONFIG_KEY_2, 'safe.directory');
    assert.equal(nestedEnv.GIT_CONFIG_VALUE_2, 'X:\\submodules\\nested-repo');
    assert.equal(nestedEnv.GIT_CONFIG_KEY_3, undefined);

    assert.equal(invoke({ GIT_EXEC_PATH: validGitPath }, 0).success, false);
    assert.equal(invoke({ GIT_EXEC_PATH: validGitPath }, 2).success, false);
    assert.equal(invoke({ GIT_EXEC_PATH: validGitPath }, 3).success, true);

    // Ensure no wildcards anywhere in the projected environment
    for (const key of Object.keys(nestedEnv)) {
      if (key.startsWith('GIT_CONFIG_VALUE_')) {
        assert.ok(!nestedEnv[key]?.includes('*'), `Safe directory value must not contain wildcards: ${nestedEnv[key]}`);
      }
    }
  });
});



test('C# Git trust discovery rejects a junction to another repository', { skip: process.platform !== 'win32' }, async () => {
  await harnessFixture(async ({ copy, runtime, outside, invoke }) => {
    await mkdir(path.join(outside, '.git'));
    await symlink(outside, path.join(copy, 'foreign-repo'), 'junction');
    const response = invoke({ GIT_EXEC_PATH: path.join(runtime, 'git', 'bin') });
    assert.equal(response.success, false);
    assert.match(response.error || '', /reparse|link/i);
  });
});
