import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DELEGATION_ASK_TOOLS,
  PERMISSION_PRESETS,
  runPermissionsCommand,
  type PermissionPreset,
} from '../src/permissions-command.js';
import { TOOL_ANNOTATIONS } from '../src/tool-annotations.js';
import { toolEnabled, type ToolProfile } from '../src/tool-profiles.js';

const profiles: readonly ToolProfile[] = ['full', 'query', 'review', 'implementation'];

function runPermissions(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const exitCode = runPermissionsCommand(
    args,
    text => { stdout += text; },
    text => { stderr += text; },
  );
  return { exitCode, stdout, stderr };
}

function assertRefusal(args: readonly string[], messageMatch?: string | RegExp): void {
  const { exitCode, stdout, stderr } = runPermissions(args);
  assert.equal(exitCode, 2);
  assert.equal(stdout, '');
  assert.ok(stderr.startsWith('antigravity-mcp-bridge permissions: '));
  if (typeof messageMatch === 'string') {
    assert.ok(stderr.includes(messageMatch));
  } else if (messageMatch instanceof RegExp) {
    assert.match(stderr, messageMatch);
  }
}

const expectedCounts: Record<PermissionPreset, Record<ToolProfile, [number, number]>> = {
  connector: {
    full: [23, 27],
    query: [23, 13],
    review: [23, 16],
    implementation: [23, 27],
  },
  delegation: {
    full: [43, 7],
    query: [34, 2],
    review: [37, 2],
    implementation: [43, 7],
  },
};

for (const preset of PERMISSION_PRESETS) {
  for (const profile of profiles) {
    test(`claude-code host permissions with preset ${preset} and profile ${profile}`, () => {
      const { exitCode, stdout, stderr } = runPermissions(['--host', 'claude-code', '--preset', preset, '--profile', profile]);
      assert.equal(exitCode, 0);
      assert.equal(stderr, '');

      const parsed = JSON.parse(stdout);
      assert.deepEqual(Object.keys(parsed), ['permissions']);
      assert.deepEqual(Object.keys(parsed.permissions), ['allow', 'ask', 'deny']);

      const { allow, ask, deny }: { allow: string[]; ask: string[]; deny: string[] } = parsed.permissions;
      assert.equal(deny.length, 0);

      const [expectedAllow, expectedAsk] = expectedCounts[preset][profile];
      assert.equal(allow.length, expectedAllow);
      assert.equal(ask.length, expectedAsk);

      const enabledTools = Object.keys(TOOL_ANNOTATIONS).filter(t => toolEnabled(profile, t));
      const expectedPrefixed = enabledTools.map(t => `mcp__antigravity__${t}`);

      const all = [...allow, ...ask, ...deny];
      for (const entry of all) {
        assert.match(entry, /^mcp__antigravity__[A-Za-z0-9_-]+$/);
      }
      assert.equal(new Set(all).size, all.length);

      const combinedInTableOrder = expectedPrefixed.filter(t => all.includes(t));
      assert.deepEqual(combinedInTableOrder, expectedPrefixed);
      assert.equal(all.length, expectedPrefixed.length);

      assert.deepEqual(allow, expectedPrefixed.filter(t => allow.includes(t)));
      assert.deepEqual(ask, expectedPrefixed.filter(t => ask.includes(t)));

      if (preset === 'connector') {
        const allowedTools = allow.map(t => t.slice('mcp__antigravity__'.length));
        const expectedReadOnly = enabledTools.filter(t => TOOL_ANNOTATIONS[t]!.readOnlyHint);
        assert.deepEqual(allowedTools, expectedReadOnly);
      } else {
        const askTools = ask.map(t => t.slice('mcp__antigravity__'.length));
        const expectedDelegationAsk = enabledTools.filter(t => DELEGATION_ASK_TOOLS.has(t));
        assert.deepEqual(askTools, expectedDelegationAsk);
      }
    });

    test(`codex host permissions with preset ${preset} and profile ${profile}`, () => {
      const { exitCode, stdout, stderr } = runPermissions(['--host', 'codex', '--preset', preset, '--profile', profile]);
      assert.equal(exitCode, 0);
      assert.equal(stderr, '');

      const lines = stdout.split('\n');
      assert.ok(!lines.some(line => line.includes('disabled_tools')));

      const toolModes = new Map<string, string>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const headerMatch = line.match(/^\[mcp_servers\.antigravity\.tools\.([A-Za-z0-9_-]+)\]$/);
        if (headerMatch) {
          const tool = headerMatch[1]!;
          const nextLine = lines[i + 1];
          assert.ok(nextLine !== undefined, `Missing approval_mode line after header for ${tool}`);
          const modeMatch = nextLine.match(/^approval_mode = "(approve|prompt)"$/);
          assert.ok(modeMatch !== null, `Expected approval_mode after header for ${tool}, got ${nextLine}`);
          assert.ok(!toolModes.has(tool), `Duplicate header for ${tool}`);
          toolModes.set(tool, modeMatch[1]!);
        }
      }

      for (const tool of Object.keys(TOOL_ANNOTATIONS)) {
        const enabled = toolEnabled(profile, tool);
        if (enabled) {
          assert.ok(toolModes.has(tool), `Missing header for enabled tool ${tool}`);
          const expectedMode = (preset === 'connector' ? TOOL_ANNOTATIONS[tool]!.readOnlyHint : !DELEGATION_ASK_TOOLS.has(tool))
            ? 'approve'
            : 'prompt';
          assert.equal(toolModes.get(tool), expectedMode, tool);
        } else {
          assert.ok(!toolModes.has(tool), `Unexpected header for disabled tool ${tool}`);
          assert.ok(!stdout.includes(`[mcp_servers.antigravity.tools.${tool}]`));
        }
      }

      const [expectedApprove, expectedPrompt] = expectedCounts[preset][profile];
      const approveCount = [...toolModes.values()].filter(m => m === 'approve').length;
      const promptCount = [...toolModes.values()].filter(m => m === 'prompt').length;
      assert.equal(approveCount, expectedApprove);
      assert.equal(promptCount, expectedPrompt);
    });
  }
}

test('--server-name changes prefix and default is antigravity', () => {
  const defaultClaude = runPermissions(['--host', 'claude-code']);
  assert.equal(defaultClaude.exitCode, 0);
  assert.equal(defaultClaude.stderr, '');
  const parsedDefaultClaude = JSON.parse(defaultClaude.stdout);
  assert.ok(parsedDefaultClaude.permissions.allow.every((t: string) => t.startsWith('mcp__antigravity__')));
  assert.ok(parsedDefaultClaude.permissions.ask.every((t: string) => t.startsWith('mcp__antigravity__')));

  const customClaude = runPermissions(['--host', 'claude-code', '--server-name', 'ag']);
  assert.equal(customClaude.exitCode, 0);
  assert.equal(customClaude.stderr, '');
  const parsedCustomClaude = JSON.parse(customClaude.stdout);
  assert.ok(parsedCustomClaude.permissions.allow.every((t: string) => t.startsWith('mcp__ag__')));
  assert.ok(parsedCustomClaude.permissions.ask.every((t: string) => t.startsWith('mcp__ag__')));
  assert.ok(!customClaude.stdout.includes('mcp__antigravity__'));

  const defaultCodex = runPermissions(['--host', 'codex']);
  assert.equal(defaultCodex.exitCode, 0);
  assert.equal(defaultCodex.stderr, '');
  assert.ok(defaultCodex.stdout.includes('[mcp_servers.antigravity.tools.'));
  assert.ok(!defaultCodex.stdout.includes('[mcp_servers.ag.tools.'));

  const customCodex = runPermissions(['--host', 'codex', '--server-name', 'ag']);
  assert.equal(customCodex.exitCode, 0);
  assert.equal(customCodex.stderr, '');
  assert.ok(customCodex.stdout.includes('[mcp_servers.ag.tools.'));
  assert.ok(!customCodex.stdout.includes('[mcp_servers.antigravity.tools.'));
});

test('--deny is repeatable, accepts bare and prefixed names, dedupes, and updates allow/ask/codex disabled_tools', () => {
  const claudeResult = runPermissions([
    '--host', 'claude-code',
    '--deny', 'antigravity_cancel',
    '--deny', 'mcp__antigravity__antigravity_run',
    '--deny', 'antigravity_cancel',
  ]);
  assert.equal(claudeResult.exitCode, 0);
  assert.equal(claudeResult.stderr, '');
  const parsedClaude = JSON.parse(claudeResult.stdout);
  assert.deepEqual(parsedClaude.permissions.deny, [
    'mcp__antigravity__antigravity_run',
    'mcp__antigravity__antigravity_cancel',
  ]);
  assert.ok(!parsedClaude.permissions.allow.includes('mcp__antigravity__antigravity_cancel'));
  assert.ok(!parsedClaude.permissions.allow.includes('mcp__antigravity__antigravity_run'));
  assert.ok(!parsedClaude.permissions.ask.includes('mcp__antigravity__antigravity_cancel'));
  assert.ok(!parsedClaude.permissions.ask.includes('mcp__antigravity__antigravity_run'));

  const codexResult = runPermissions([
    '--host', 'codex',
    '--deny', 'antigravity_cancel',
    '--deny', 'mcp__antigravity__antigravity_run',
    '--deny', 'antigravity_cancel',
  ]);
  assert.equal(codexResult.exitCode, 0);
  assert.equal(codexResult.stderr, '');
  assert.ok(codexResult.stdout.includes('[mcp_servers.antigravity]\ndisabled_tools = ["antigravity_run", "antigravity_cancel"]'));
  assert.ok(!codexResult.stdout.includes('[mcp_servers.antigravity.tools.antigravity_cancel]'));
  assert.ok(!codexResult.stdout.includes('[mcp_servers.antigravity.tools.antigravity_run]'));
});

test('refusals for invalid arguments', () => {
  assertRefusal(['--host', 'claude-code', '--deny', 'mcp__other__antigravity_run'], 'expected "mcp__antigravity__"');
  assertRefusal(['--host', 'claude-code', '--server-name', 'ag', '--deny', 'mcp__antigravity__antigravity_run'], 'expected "mcp__ag__"');
  assertRefusal(['--host', 'claude-code', '--deny', 'toString'], 'Unknown tool "toString"');
  assertRefusal(['--host', 'claude-code', '--deny', 'antigravity_nope'], 'Unknown tool "antigravity_nope"');
  assertRefusal(['--host', 'claude-code', '--profile', 'query', '--deny', 'antigravity_integrate'], 'is not available in the "query" profile');
  assertRefusal(['--host', 'claude-code', '--deny'], 'Option --deny requires a value');
  assertRefusal([], 'Missing required option --host');
  assertRefusal(['--host', 'invalid-host'], 'Invalid host: invalid-host');
  assertRefusal(['--host', 'claude-code', '--preset', 'invalid-preset'], 'Invalid preset: invalid-preset');
  assertRefusal(['--host', 'claude-code', '--profile', 'invalid-profile'], 'Invalid profile: invalid-profile');
  assertRefusal(['--host', 'claude-code', '--host', 'codex'], 'Option --host cannot be specified more than once');
  assertRefusal(['--host', 'claude-code', '--server-name', 'a.b'], 'Invalid server name: a.b');
  assertRefusal(['--host', 'codex', '--server-name', '--help'], 'Invalid server name: --help');
  assertRefusal(['--host', 'claude-code', '--server-name', '-h'], 'Invalid server name: -h');
  assertRefusal(['--host', 'claude-code', '--server-name', '-ag'], 'Invalid server name: -ag. Must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/');
  assertRefusal(['--host', 'claude-code', '--unknown-flag'], 'Unknown option: --unknown-flag');
  assertRefusal(['--host', 'claude-code', 'extra-arg'], 'Unexpected positional argument: extra-arg');
  assertRefusal(['--host', 'claude-code', '--deny', 'unknown_tool', '--help'], 'Option --help cannot be combined with other arguments');
  assertRefusal(['--host', 'claude-code', '--deny', 'mcp__other__antigravity_run', '--help'], 'Option --help cannot be combined with other arguments');
  assertRefusal(['--host', 'claude-code', '--profile', 'query', '--deny', 'antigravity_integrate', '-h'], 'Option --help cannot be combined with other arguments');
  assertRefusal(['--help', '--host', 'claude-code'], 'Option --help cannot be combined with other arguments');
});

test('--help exits 0 and prints usage to stdout', () => {
  for (const flag of ['--help', '-h']) {
    const { exitCode, stdout, stderr } = runPermissions([flag]);
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.startsWith('Usage: antigravity-mcp-bridge permissions'));
    assert.ok(stdout.includes('--host <claude-code|codex>'));
    assert.ok(stdout.includes('--preset <connector|delegation>'));
  }
});

test('--deny removes a tool that the preset would allow', () => {
  const claudeResult = runPermissions(['--host', 'claude-code', '--deny', 'antigravity_health']);
  assert.equal(claudeResult.exitCode, 0);
  assert.equal(claudeResult.stderr, '');
  const parsedClaude = JSON.parse(claudeResult.stdout);
  const { allow, ask, deny } = parsedClaude.permissions;
  assert.deepEqual(deny, ['mcp__antigravity__antigravity_health']);
  assert.ok(!allow.includes('mcp__antigravity__antigravity_health'));
  assert.ok(!ask.includes('mcp__antigravity__antigravity_health'));
  assert.equal(allow.length, 22);

  const codexResult = runPermissions(['--host', 'codex', '--deny', 'antigravity_health']);
  assert.equal(codexResult.exitCode, 0);
  assert.equal(codexResult.stderr, '');
  assert.ok(codexResult.stdout.includes('disabled_tools = ["antigravity_health"]'));
  assert.ok(!codexResult.stdout.includes('[mcp_servers.antigravity.tools.antigravity_health]'));
});

test('end-to-end CLI execution through entrypoint', async () => {
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-permissions-cli-test-'));
  try {
    const env: NodeJS.ProcessEnv = {
      HOME: tempDir,
      USERPROFILE: tempDir,
      APPDATA: tempDir,
      LOCALAPPDATA: tempDir,
      CODEX_HOME: tempDir,
      BRIDGE_STATE_DIRECTORY: tempDir,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    };

    const result = spawnSync(process.execPath, [entry, 'permissions', '--host', 'claude-code', '--deny', 'antigravity_cancel'], {
      cwd: tempDir,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.permissions.deny, ['mcp__antigravity__antigravity_cancel']);
    assert.ok(!parsed.permissions.allow.includes('mcp__antigravity__antigravity_cancel'));
    assert.ok(!parsed.permissions.ask.includes('mcp__antigravity__antigravity_cancel'));

    const entries = await readdir(tempDir, { recursive: true });
    assert.equal(entries.length, 0);

    const refusal = spawnSync(process.execPath, [entry, 'permissions', '--host', 'claude-code', '--deny', 'unknown_tool'], {
      cwd: tempDir,
      env,
      encoding: 'utf8',
    });
    assert.equal(refusal.status, 2);
    assert.equal(refusal.stdout, '');
    assert.match(refusal.stderr, /^antigravity-mcp-bridge permissions: /);

    const entriesAfter = await readdir(tempDir, { recursive: true });
    assert.equal(entriesAfter.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
