import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, lstat, symlink, rename, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  stageExecutionPolicy,
  verifyExecutionPolicy,
  readExecutionPolicyReceipt,
  discardExecutionPolicy,
  stagedExecutionPolicySchema,
  EXECUTION_POLICY_PATHS,
} from '../src/execution-policy.js';
import { resolveAgentPolicy, type McpCatalogEntry } from '../src/agent-policy.js';
import { DEFAULT_PROJECT_LIMITS } from '../src/config.js';

async function removeFixture(directory: string) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(['agy-mcp-copy-', 'state-sibling-', 'foreign-state-'].some(prefix => path.basename(directory).startsWith(prefix)));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function createCatalog(): McpCatalogEntry[] {
  return [
    {
      id: 'echo-server',
      command: process.execPath,
      args: ['--version'],
      env: { SECRET_TOKEN: 'top-secret-catalog-token-xyz' },
      tools: [
        { name: 'echo', readOnly: true },
        { name: 'unused_tool', readOnly: true },
      ],
    },
  ];
}

async function runHook(
  agentsDir: string,
  input: unknown
): Promise<{ decision: string; reason?: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bridge-execution-hook.mjs'], {
      cwd: agentsDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    child.once('error', reject);
    child.once('close', (exitCode) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ decision: parsed.decision, reason: parsed.reason, exitCode });
      } catch (err) {
        reject(
          new Error(
            `Failed to parse hook stdout: "${stdout}" (stderr: "${stderr}", exitCode: ${exitCode})`
          )
        );
      }
    });

    const body = typeof input === 'string' ? input : JSON.stringify(input);
    child.stdin.end(body);
  });
}

test('staging execution policy creates 4 helpers and receipt, enforces limits and verifies safely', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));

  try {
    const catalog = createCatalog();
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      {
        allowedTools: ['finish', 'view_file', 'write_to_file'],
        mcpServers: [{ serverId: 'echo-server', tools: ['echo'] }],
      },
      ['finish', 'view_file', 'write_to_file'],
      catalog,
      'write',
      executionId
    );

    const staged = await stageExecutionPolicy(
      copyDir,
      {
        policy,
        catalog,
        stateDirectory: stateDir,
        executionId,
        skillFiles: ['.agents/skills/safe-skill/SKILL.md'],
      },
      DEFAULT_PROJECT_LIMITS
    );

    // Schema validation succeeds
    const validated = stagedExecutionPolicySchema.parse(staged);
    assert.equal(validated.executionId, executionId);
    assert.equal(validated.files.length, 4);

    // Exact paths staged
    const stagedPaths = staged.files.map((f) => f.path).sort();
    assert.deepEqual(stagedPaths, [...EXECUTION_POLICY_PATHS].sort());

    // Unique hashes and sizes
    const hashes = new Set(staged.files.map((f) => f.sha256));
    assert.equal(hashes.size, 4);

    // Permissions list exact mcp(server/tool) resource without wildcard
    const serverName = policy.mcpServers[0]!.serverName;
    assert.deepEqual(staged.requiredNativePermissions, [`mcp(${serverName}/echo)`]);

    // Verify MCP config has disabledTools for unselected catalog tool
    const mcpConfigRaw = JSON.parse(
      await readFile(path.join(copyDir, '.agents', 'mcp_config.json'), 'utf8')
    );
    assert.ok(mcpConfigRaw.mcpServers[serverName]);
    assert.deepEqual(mcpConfigRaw.mcpServers[serverName].disabledTools, ['unused_tool']);

    // Verify no secret credentials in returned metadata or manifest
    const stagedJson = JSON.stringify(staged);
    assert.equal(stagedJson.includes('top-secret-catalog-token-xyz'), false);

    const manifestText = await readFile(
      path.join(copyDir, '.agents', 'bridge-execution-policy.json'),
      'utf8'
    );
    assert.equal(manifestText.includes('top-secret-catalog-token-xyz'), false);

    // verifyExecutionPolicy succeeds
    await verifyExecutionPolicy(copyDir, staged, stateDir);

    // Missing helper file triggers verification failure
    await rm(path.join(copyDir, '.agents', 'mcp_config.json'));
    await assert.rejects(
      async () => verifyExecutionPolicy(copyDir, staged, stateDir),
      { name: 'BridgeError', code: 'EXECUTION_POLICY_VERIFICATION_FAILED' }
    );
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('stageExecutionPolicy rejects conflicts, limits and preexisting receipt collision with clean rollback', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));

  try {
    const catalog = createCatalog();
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      { allowedTools: ['finish', 'view_file'] },
      ['finish', 'view_file'],
      catalog,
      'read-only',
      executionId
    );

    // 1. Conflict rejection: pre-existing managed file
    await mkdir(path.join(copyDir, '.agents'), { recursive: true });
    await writeFile(path.join(copyDir, '.agents', 'hooks.json'), '{"existing":true}');

    await assert.rejects(
      async () =>
        stageExecutionPolicy(
          copyDir,
          { policy, catalog, stateDirectory: stateDir, executionId },
          DEFAULT_PROJECT_LIMITS
        ),
      { name: 'BridgeError', code: 'CONFLICTING_EXECUTION_POLICY' }
    );
    // Pre-existing file kept untouched, no other managed files created
    assert.equal(
      await readFile(path.join(copyDir, '.agents', 'hooks.json'), 'utf8'),
      '{"existing":true}'
    );
    await rm(path.join(copyDir, '.agents', 'hooks.json'));

    // 2. Limit rejection: maxCopyFiles limit exceeded
    await assert.rejects(
      async () =>
        stageExecutionPolicy(
          copyDir,
          { policy, catalog, stateDirectory: stateDir, executionId },
          { ...DEFAULT_PROJECT_LIMITS, maxCopyFiles: 2 }
        ),
      { name: 'BridgeError', code: 'COPY_LIMIT_EXCEEDED' }
    );

    // 3. Limit rejection: maxCopyBytes limit exceeded
    await assert.rejects(
      async () =>
        stageExecutionPolicy(
          copyDir,
          { policy, catalog, stateDirectory: stateDir, executionId },
          { ...DEFAULT_PROJECT_LIMITS, maxCopyBytes: 10 }
        ),
      { name: 'BridgeError', code: 'COPY_LIMIT_EXCEEDED' }
    );

    // 4. Receipt collision: preexisting receipt file
    const receiptsDir = path.join(stateDir, 'execution-receipts');
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(path.join(receiptsDir, `${executionId}.jsonl`), 'existing');

    await assert.rejects(
      async () =>
        stageExecutionPolicy(
          copyDir,
          { policy, catalog, stateDirectory: stateDir, executionId },
          DEFAULT_PROJECT_LIMITS
        ),
      { name: 'BridgeError', code: 'RECEIPT_COLLISION' }
    );

    // Rollback verified: helper files were not left behind
    const agentsEntries = await lstat(path.join(copyDir, '.agents', 'bridge-execution-hook.mjs')).catch(() => null);
    assert.equal(agentsEntries, null);
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('verifyExecutionPolicy rejects same-size tamper, mutated policy hash and boundary mismatch', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));

  try {
    const catalog = createCatalog();
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      { allowedTools: ['finish', 'view_file'] },
      ['finish', 'view_file'],
      catalog,
      'read-only',
      executionId
    );

    const staged = await stageExecutionPolicy(
      copyDir,
      { policy, catalog, stateDirectory: stateDir, executionId },
      DEFAULT_PROJECT_LIMITS
    );

    // Same-size tamper of hooks.json
    const hooksPath = path.join(copyDir, '.agents', 'hooks.json');
    const originalHooks = await readFile(hooksPath, 'utf8');
    // Mutate one character without changing length
    const tampered = originalHooks.replace('10', '11');
    assert.equal(Buffer.byteLength(originalHooks), Buffer.byteLength(tampered));
    await writeFile(hooksPath, tampered);

    await assert.rejects(
      async () => verifyExecutionPolicy(copyDir, staged, stateDir),
      { name: 'BridgeError', code: 'EXECUTION_POLICY_VERIFICATION_FAILED' }
    );

    // Restore hooks.json
    await writeFile(hooksPath, originalHooks);
    await verifyExecutionPolicy(copyDir, staged, stateDir);

    // Mutated policy hash in staged metadata
    const corruptStaged = structuredClone(staged);
    corruptStaged.policy.sha256 = 'f'.repeat(64);
    await assert.rejects(
      async () => verifyExecutionPolicy(copyDir, corruptStaged, stateDir),
      { name: 'BridgeError', code: 'EXECUTION_POLICY_VERIFICATION_FAILED' }
    );

    // Foreign stateDirectory boundary mismatch
    const foreignStateDir = await mkdtemp(path.join(os.tmpdir(), 'foreign-state-'));
    try {
      await assert.rejects(
        async () => verifyExecutionPolicy(copyDir, staged, foreignStateDir),
        { name: 'BridgeError', code: 'EXECUTION_POLICY_VERIFICATION_FAILED' }
      );
    } finally {
      await removeFixture(foreignStateDir);
    }
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('table-driven generated hook execution controls native tools, MCP, safe ancestry, paths and spaces', async () => {
  // Use directory path containing spaces in os.tmpdir()
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-path with spaces-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-path with spaces-'));

  try {
    const catalog = createCatalog();
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      {
        allowedTools: ['finish', 'view_file', 'write_to_file'],
        mcpServers: [{ serverId: 'echo-server', tools: ['echo'] }],
      },
      ['finish', 'view_file', 'write_to_file'],
      catalog,
      'write',
      executionId
    );

    const staged = await stageExecutionPolicy(
      copyDir,
      {
        policy,
        catalog,
        stateDirectory: stateDir,
        executionId,
        skillFiles: ['.agents/skills/sample-skill/SKILL.md'],
        readOnlyRoots: [path.join(stateDir, 'skill-snapshot')],
      },
      DEFAULT_PROJECT_LIMITS
    );

    const agentsDir = path.join(copyDir, '.agents');
    const serverName = policy.mcpServers[0]!.serverName;

    // Create test files
    const existingFile = path.join(copyDir, 'hello.txt');
    await writeFile(existingFile, 'Hello world');

    const skillDir = path.join(copyDir, '.agents', 'skills', 'sample-skill');
    await mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await writeFile(skillFile, '---\nname: sample-skill\n---\nBody');

    const conversationId = 'conv-test-123';

    // Table of positive and negative cases
    const testCases: Array<{
      name: string;
      input: unknown;
      expectedDecision: 'allow' | 'deny';
    }> = [
      {
        name: 'positive finish tool',
        input: { toolCall: { name: 'finish', args: {} }, conversationId },
        expectedDecision: 'allow',
      },
      {
        name: 'positive view_file on existing file within copy',
        input: { toolCall: { name: 'view_file', args: { AbsolutePath: existingFile } }, conversationId },
        expectedDecision: 'allow',
      },
      {
        name: 'positive write_to_file on new leaf through safe existing ancestry',
        input: { toolCall: { name: 'write_to_file', args: { TargetFile: path.join(copyDir, 'new-file.txt') } }, conversationId },
        expectedDecision: 'allow',
      },
      {
        name: 'positive call_mcp_tool on selected server and tool',
        input: {
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: serverName, ToolName: 'echo', Arguments: { message: 'hello' } },
          },
          conversationId,
        },
        expectedDecision: 'allow',
      },
      {
        name: 'positive view_file on explicitly allowed skill file in .agents',
        input: { toolCall: { name: 'view_file', args: { AbsolutePath: skillFile } }, conversationId },
        expectedDecision: 'allow',
      },
      {
        name: 'negative view_file on unlisted file in .agents',
        input: {
          toolCall: { name: 'view_file', args: { AbsolutePath: path.join(copyDir, '.agents', 'hooks.json') } },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative write_to_file into .agents',
        input: {
          toolCall: { name: 'write_to_file', args: { TargetFile: path.join(copyDir, '.agents', 'hacked.txt') } },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'positive read of a bundled read-only skill resource',
        input: { toolCall: { name: 'view_file', args: { AbsolutePath: path.join(stateDir, 'skill-snapshot', 'design', 'SKILL.md') } }, conversationId },
        expectedDecision: 'allow',
      },
      {
        name: 'negative write into a bundled read-only skill resource',
        input: { toolCall: { name: 'write_to_file', args: { TargetFile: path.join(stateDir, 'skill-snapshot', 'design', 'SKILL.md') } }, conversationId },
        expectedDecision: 'deny',
      },
      {
        name: 'negative external file access outside copy',
        input: {
          toolCall: { name: 'view_file', args: { AbsolutePath: path.join(stateDir, 'private.txt') } },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative access to .git path',
        input: {
          toolCall: { name: 'view_file', args: { AbsolutePath: path.join(copyDir, '.git', 'config') } },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative unselected MCP tool on same server',
        input: {
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: serverName, ToolName: 'unused_tool', Arguments: {} },
          },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative unknown MCP server name',
        input: {
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'foreign_server', ToolName: 'echo', Arguments: {} },
          },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative MCP oversized arguments (>50000 bytes)',
        input: {
          toolCall: {
            name: 'call_mcp_tool',
            args: {
              ServerName: serverName,
              ToolName: 'echo',
              Arguments: { bigData: 'x'.repeat(60000) },
            },
          },
          conversationId,
        },
        expectedDecision: 'deny',
      },
      {
        name: 'negative unpermitted tool (run_command / terminal)',
        input: { toolCall: { name: 'run_command', args: { command: 'echo 1' } }, conversationId },
        expectedDecision: 'deny',
      },
      {
        name: 'negative malformed json input fails closed',
        input: '{"invalid": json',
        expectedDecision: 'deny',
      },
      {
        name: 'negative missing toolCall name',
        input: { toolCall: {}, conversationId },
        expectedDecision: 'deny',
      },
    ];

    for (const tc of testCases) {
      const res = await runHook(agentsDir, tc.input);
      assert.equal(res.decision, tc.expectedDecision, `Test case failed: ${tc.name} (${res.reason})`);
      assert.equal(res.exitCode, 0);
    }

    // Receipt window verification
    const receiptAfter = await readExecutionPolicyReceipt(staged, stateDir, 0, conversationId);
    assert.equal(receiptAfter.guardedFinish, true);
    assert.ok(receiptAfter.decisionCount > 0);
    assert.ok(receiptAfter.deniedCount > 0);
    assert.ok(receiptAfter.nextOffset > 0);
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('hook enforces read-only mode, rejects junctions and invalid receipt offsets', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));

  try {
    const catalog = createCatalog();
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      { allowedTools: ['finish', 'view_file'] },
      ['finish', 'view_file'],
      catalog,
      'read-only',
      executionId
    );

    const staged = await stageExecutionPolicy(
      copyDir,
      { policy, catalog, stateDirectory: stateDir, executionId },
      DEFAULT_PROJECT_LIMITS
    );

    const agentsDir = path.join(copyDir, '.agents');
    const existingFile = path.join(copyDir, 'test.txt');
    await writeFile(existingFile, 'Read only test');

    // In read-only mode: write_to_file is denied
    const writeRes = await runHook(agentsDir, {
      toolCall: { name: 'write_to_file', args: { TargetFile: path.join(copyDir, 'write-deny.txt') } },
      conversationId: 'ro-test',
    });
    assert.equal(writeRes.decision, 'deny');

    // Reading existing file is allowed
    const readRes = await runHook(agentsDir, {
      toolCall: { name: 'view_file', args: { AbsolutePath: existingFile } },
      conversationId: 'ro-test',
    });
    assert.equal(readRes.decision, 'allow');

    // Test junction / symlink rejection if supported by platform
    const nestedDir = path.join(copyDir, 'nested-real');
    await mkdir(nestedDir);
    const linkDir = path.join(copyDir, 'nested-link');
      if (process.platform === 'win32') {
        await symlink(nestedDir, linkDir, 'junction');
      } else {
        await symlink(nestedDir, linkDir);
      }
    {
      const linkFile = path.join(linkDir, 'through-link.txt');
      await writeFile(path.join(nestedDir, 'through-link.txt'), 'hello');
      const junctionRes = await runHook(agentsDir, {
        toolCall: { name: 'view_file', args: { AbsolutePath: linkFile } },
        conversationId: 'ro-test',
      });
      assert.equal(junctionRes.decision, 'deny');
    }

    // Receipt offset window test: prior finish before offset must NOT validate a new run
    // Execute finish tool
    await runHook(agentsDir, {
      toolCall: { name: 'finish', args: {} },
      conversationId: 'ro-test',
    });

    const receipt1 = await readExecutionPolicyReceipt(staged, stateDir, 0, 'ro-test');
    assert.equal(receipt1.guardedFinish, true);
    const offset1 = receipt1.nextOffset;

    // Read with offset1 without emitting new finish
    const receipt2 = await readExecutionPolicyReceipt(staged, stateDir, offset1, 'ro-test');
    assert.equal(receipt2.guardedFinish, false);
    assert.equal(receipt2.decisionCount, 0);

    // Reading with invalid offset (not at line boundary) fails
    await assert.rejects(
      async () => readExecutionPolicyReceipt(staged, stateDir, 1, 'ro-test'),
      { name: 'BridgeError', code: 'INVALID_RECEIPT_OFFSET' }
    );

    // Filtering by wrong conversationId returns 0 decisions
    const receiptWrongConv = await readExecutionPolicyReceipt(staged, stateDir, 0, 'wrong-conv-id');
    assert.equal(receiptWrongConv.decisionCount, 0);
    assert.equal(receiptWrongConv.guardedFinish, false);
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});


test('receipt replacement is denied by both native hook and independent reader', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const policy = resolveAgentPolicy({ allowedTools: [] }, [], [], 'read-only', randomUUID());
    const staged = await stageExecutionPolicy(copyDir, { policy, catalog: [], stateDirectory: stateDir, executionId: randomUUID() }, DEFAULT_PROJECT_LIMITS);
    await rename(staged.receiptPath, staged.receiptPath + '.old'); await writeFile(staged.receiptPath, '');
    const result = await runHook(path.join(copyDir, '.agents'), { toolCall: { name: 'finish', args: {} }, conversationId: 'replacement' });
    assert.equal(result.decision, 'deny');
    await assert.rejects(readExecutionPolicyReceipt(staged, stateDir), { code: 'INVALID_RECEIPT' });
    await assert.rejects(verifyExecutionPolicy(copyDir, staged, stateDir), { code: 'EXECUTION_POLICY_VERIFICATION_FAILED' });
  } finally { await removeFixture(copyDir); await removeFixture(stateDir); }
});
test('new nested files are allowed while traversal, hardlinks and runtime shadows are denied', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const policy = resolveAgentPolicy({ allowedTools: ['view_file', 'write_to_file'] }, ['view_file', 'write_to_file'], [], 'write', randomUUID());
    await mkdir(path.join(copyDir, '.agents')); await writeFile(path.join(copyDir, '.agents', 'node.exe'), 'inert fixture');
    await assert.rejects(stageExecutionPolicy(copyDir, { policy, catalog: [], stateDirectory: stateDir, executionId: randomUUID() }, DEFAULT_PROJECT_LIMITS), { code: 'CONFLICTING_EXECUTION_POLICY' });
    await rm(path.join(copyDir, '.agents', 'node.exe'));
    await stageExecutionPolicy(copyDir, { policy, catalog: [], stateDirectory: stateDir, executionId: randomUUID() }, DEFAULT_PROJECT_LIMITS);
    const agents = path.join(copyDir, '.agents');
    assert.equal((await runHook(agents, { toolCall: { name: 'write_to_file', args: { TargetFile: path.join(copyDir, 'new', 'nested', 'file.txt') } }, conversationId: 'nested' })).decision, 'allow');
    assert.equal((await runHook(agents, { toolCall: { name: 'write_to_file', args: { TargetFile: copyDir + '/new/../file.txt' } }, conversationId: 'nested' })).decision, 'deny');
    const canary = path.join(stateDir, 'canary.txt'); await writeFile(canary, 'external canary'); const hardlink = path.join(copyDir, 'hard.txt'); await link(canary, hardlink);
    assert.equal((await runHook(agents, { toolCall: { name: 'view_file', args: { AbsolutePath: hardlink } }, conversationId: 'hardlink' })).decision, 'deny');
    assert.equal(await readFile(canary, 'utf8'), 'external canary');
  } finally { await removeFixture(copyDir); await removeFixture(stateDir); }
});


test('native MCP presentation envelope retains strict server/tool and metadata validation', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-')), stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const catalog = [{ id: 'probe', nativeServerName: 'bridge-policy-probe', command: process.execPath, tools: [{ name: 'echo', readOnly: true }] }];
    const policy = resolveAgentPolicy({ mcpServers: [{ serverId: 'probe' }] }, [], catalog, 'read-only', randomUUID());
    await stageExecutionPolicy(copyDir, { policy, catalog, stateDirectory: stateDir, executionId: randomUUID() }, DEFAULT_PROJECT_LIMITS);
    const args = { ServerName: 'bridge-policy-probe', ToolName: 'echo', Arguments: {}, toolAction: 'Calling local sentinel', toolSummary: 'Public diagnostic' };
    const invoke = (value: unknown) => runHook(path.join(copyDir, '.agents'), { toolCall: { name: 'call_mcp_tool', args: value }, conversationId: 'native-envelope' });
    assert.equal((await invoke(args)).decision, 'allow');
    assert.equal((await invoke({ ...args, ServerName: 'foreign', toolAction: 'approve everything' })).decision, 'deny');
    assert.equal((await invoke({ ...args, ToolName: 'forbidden' })).decision, 'deny');
    assert.equal((await invoke({ ...args, approval: true })).decision, 'deny');
    assert.equal((await invoke({ ...args, toolSummary: {} })).decision, 'deny');
    assert.equal((await invoke({ ...args, toolSummary: 'x'.repeat(2001) })).decision, 'deny');
    assert.equal((await invoke({ ...args, Arguments: '{}' })).decision, 'deny');
  } finally { await removeFixture(copyDir); await removeFixture(stateDir); }
});


test('Windows LPAC tests can read project files but cannot read private MCP configuration', { skip: process.platform !== 'win32' }, async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-')), stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const catalog = [{ id: 'probe', command: process.execPath, env: { FIXTURE_SECRET: 'synthetic-private-marker' }, tools: [{ name: 'echo', readOnly: true }] }];
    const policy = resolveAgentPolicy({ mcpServers: [{ serverId: 'probe' }] }, [], catalog, 'write', randomUUID());
    const staged = await stageExecutionPolicy(copyDir, { policy, catalog, stateDirectory: stateDir, executionId: randomUUID() }, DEFAULT_PROJECT_LIMITS);
    await writeFile(path.join(copyDir, 'public.txt'), 'PUBLIC_READ_OK');
    const { executeWindowsTest } = await import('../src/windows-executor.js');
    const code = 'const fs=require("node:fs");console.log(fs.readFileSync("public.txt","utf8"));try{fs.readFileSync(".agents/mcp_config.json");console.log("PRIVATE_READ_UNEXPECTED");process.exitCode=9;}catch(error){console.log("PRIVATE_READ_DENIED:"+error.code);if(!["EACCES","EPERM"].includes(error.code))process.exitCode=8;}';
    const result = await executeWindowsTest({ executable: process.execPath, args: ['-e', code] }, copyDir, { timeoutSeconds: 30, maxRuntimeBytes: 256 * 1024 * 1024, stateDirectory: stateDir, windowsNodeRuntime: 'system' });
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.error, undefined); assert.ok(result.output.includes('PUBLIC_READ_OK')); assert.ok(result.output.includes('PRIVATE_READ_DENIED:')); assert.ok(!result.output.includes('synthetic-private-marker')); assert.equal(result.profileDeleted, true); assert.equal(result.aliasesDeleted, true);
    await verifyExecutionPolicy(copyDir, staged, stateDir);
  } finally { await removeFixture(copyDir); await removeFixture(stateDir); }
});

test('receipts retain canonical identity while I/O stays under the authorized state address', async t => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  const originalRealpath = fsPromises.realpath;
  const canonicalState = path.join(await originalRealpath(path.dirname(stateDir)), 'foreign-state-' + randomUUID());
  const canonicalCopy = path.join(await originalRealpath(path.dirname(copyDir)), 'agy-mcp-copy-canonical-' + randomUUID());
  const within = (root: string, input: unknown) => {
    const relative = path.relative(root, path.resolve(String(input)));
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  let deniedCalls = 0;
  try {
    t.mock.method(fsPromises, 'realpath', (async (...args: Parameters<typeof originalRealpath>) => {
      const actual = await Reflect.apply(originalRealpath, fsPromises, args);
      if (typeof actual !== 'string') return actual;
      if (within(stateDir, args[0])) return path.join(canonicalState, path.relative(stateDir, path.resolve(String(args[0]))));
      if (within(copyDir, args[0])) return path.join(canonicalCopy, path.relative(copyDir, path.resolve(String(args[0]))));
      return actual;
    }) as typeof originalRealpath);
    for (const method of ['mkdir', 'lstat', 'open', 'unlink'] as const) {
      const original = fsPromises[method];
      t.mock.method(fsPromises, method, ((...args: Parameters<typeof original>) => {
        if (within(canonicalState, args[0]) || within(canonicalCopy, args[0])) {
          deniedCalls++;
          throw Object.assign(new Error('Canonical address is inaccessible'), { code: 'EPERM' });
        }
        return Reflect.apply(original, fsPromises, args);
      }) as typeof original);
    }
    syncBuiltinESMExports();
    const executionId = randomUUID(), catalog = createCatalog();
    const policy = resolveAgentPolicy({ allowedTools: ['finish', 'view_file'] }, ['finish', 'view_file'], catalog, 'read-only', executionId);
    const staged = await stageExecutionPolicy(copyDir, { policy, catalog, stateDirectory: stateDir, executionId }, DEFAULT_PROJECT_LIMITS);
    assert.equal(staged.receiptPath, path.join(canonicalState, 'execution-receipts', executionId + '.jsonl'));
    await verifyExecutionPolicy(copyDir, staged, stateDir);
    const addressedReceipt = path.join(stateDir, 'execution-receipts', executionId + '.jsonl');
    await fsPromises.appendFile(addressedReceipt, JSON.stringify({ executionId, policySha256: policy.sha256,
      conversationId: 'authorized-address', toolName: 'finish', decision: 'allow' }) + '\n');
    const receipt = await readExecutionPolicyReceipt(staged, stateDir, 0, 'authorized-address');
    assert.equal(receipt.decisionCount, 1);
    assert.equal(receipt.guardedFinish, true);
    await discardExecutionPolicy(staged, stateDir);
    await discardExecutionPolicy(staged, stateDir);
    await assert.rejects(fsPromises.lstat(addressedReceipt), { code: 'ENOENT' });
    for (const file of EXECUTION_POLICY_PATHS) await fsPromises.rm(path.join(copyDir, file));
    const originalWrite = fsPromises.writeFile;
    t.mock.method(fsPromises, 'writeFile', (async (...args: Parameters<typeof originalWrite>) => {
      if (path.basename(String(args[0])) === 'bridge-execution-hook.mjs') {
        throw Object.assign(new Error('Controlled helper write failure'), { code: 'EACCES' });
      }
      return Reflect.apply(originalWrite, fsPromises, args);
    }) as typeof originalWrite);
    syncBuiltinESMExports();
    const rejectedId = randomUUID();
    await assert.rejects(stageExecutionPolicy(copyDir, { policy, catalog, stateDirectory: stateDir, executionId: rejectedId }, DEFAULT_PROJECT_LIMITS), { code: 'EACCES' });
    await assert.rejects(fsPromises.lstat(path.join(copyDir, '.agents/hooks.json')), { code: 'ENOENT' });
    await assert.rejects(fsPromises.lstat(path.join(stateDir, 'execution-receipts', rejectedId + '.jsonl')), { code: 'ENOENT' });
    assert.equal(deniedCalls, 0, 'Canonical identity must not become an I/O address');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('receipt cleanup preserves the file when canonical verification is denied', async t => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const executionId = randomUUID(), catalog = createCatalog();
    const policy = resolveAgentPolicy({ allowedTools: ['finish'] }, ['finish'], catalog, 'read-only', executionId);
    const staged = await stageExecutionPolicy(copyDir, { policy, catalog, stateDirectory: stateDir, executionId }, DEFAULT_PROJECT_LIMITS);
    const addressedReceipt = path.join(stateDir, 'execution-receipts', executionId + '.jsonl');
    const originalRealpath = fsPromises.realpath;
    let denied = false;
    t.mock.method(fsPromises, 'realpath', (async (...args: Parameters<typeof originalRealpath>) => {
      if (path.resolve(String(args[0])) === path.resolve(addressedReceipt)) {
        denied = true;
        throw Object.assign(new Error('Receipt canonical verification denied'), { code: 'EACCES' });
      }
      return Reflect.apply(originalRealpath, fsPromises, args);
    }) as typeof originalRealpath);
    syncBuiltinESMExports();
    await assert.rejects(discardExecutionPolicy(staged, stateDir), { code: 'EACCES' });
    assert.equal(denied, true);
    assert.equal((await fsPromises.lstat(addressedReceipt)).isFile(), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});

test('modern CLI file tool aliases normalize capabilities, validate envelopes, and preserve path and receipt invariants', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));

  try {
    const catalog = createCatalog();
    const agentsDir = path.join(copyDir, '.agents');
    const clearFixturePolicy = async (staged: Awaited<ReturnType<typeof stageExecutionPolicy>>) => {
      await discardExecutionPolicy(staged, stateDir);
      for (const relative of EXECUTION_POLICY_PATHS) await rm(path.join(copyDir, relative));
    };
    const existingFile = path.join(copyDir, 'hello.txt');
    await writeFile(existingFile, 'Hello world');

    const newFileInSubdir = path.join(copyDir, 'nested', 'created.txt');
    const missingFile = path.join(copyDir, 'missing.txt');
    const outsideFile = path.join(stateDir, 'outside.txt');
    await writeFile(outsideFile, 'Outside content');

    const gitDir = path.join(copyDir, '.git');
    await mkdir(gitDir, { recursive: true });
    const gitConfig = path.join(gitDir, 'config');
    await writeFile(gitConfig, '[core]');

    const skillDir = path.join(copyDir, '.agents', 'skills', 'sample-skill');
    await mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await writeFile(skillFile, '---\nname: sample-skill\n---\nBody');

    const hardlinkSrc = path.join(copyDir, 'hardlink-src.txt');
    const hardlinkDst = path.join(copyDir, 'hardlink-dst.txt');
    await writeFile(hardlinkSrc, 'Hardlink data');
    await link(hardlinkSrc, hardlinkDst);

    const outsideLinkedDir = path.join(stateDir, 'linked-dir');
    await mkdir(outsideLinkedDir, { recursive: true });
    await writeFile(path.join(outsideLinkedDir, 'secret.txt'), 'Secret');
    const symlinkDir = path.join(copyDir, 'symlink-dir');
    await symlink(outsideLinkedDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');

    // Stage 1: Full read/write/edit policy
    const execFull = randomUUID();
    const fullPolicy = resolveAgentPolicy(
      {
        allowedTools: ['finish', 'view_file', 'write_to_file', 'replace_file_content'],
        mcpServers: [{ serverId: 'echo-server', tools: ['echo'] }],
      },
      ['finish', 'view_file', 'write_to_file', 'replace_file_content'],
      catalog,
      'write',
      execFull
    );
    const stagedFull = await stageExecutionPolicy(
      copyDir,
      {
        policy: fullPolicy,
        catalog,
        stateDirectory: stateDir,
        executionId: execFull,
        skillFiles: ['.agents/skills/sample-skill/SKILL.md'],
      },
      DEFAULT_PROJECT_LIMITS
    );

    const conversationId = 'conv-modern-aliases';
    const unsafeInt = Number.MAX_SAFE_INTEGER + 1;

    const cases: Array<[string, string, unknown, 'allow' | 'deny']> = [
      // Positive modern aliases & legacy preservation
      ['read_file positive', 'read_file', { Path: existingFile }, 'allow'],
      ['read_file with range/offset/metadata', 'read_file', { Path: existingFile, StartLine: 1, EndLine: 10, ByteOffset: 0, toolSummary: 'Read file' }, 'allow'],
      ['read_file allowed skill in .agents', 'read_file', { Path: skillFile }, 'allow'],
      ['write_file existing file', 'write_file', { Path: existingFile, Content: 'Updated', Overwrite: true }, 'allow'],
      ['write_file new file in non-existent subdir', 'write_file', { Path: newFileInSubdir, Content: 'New', Append: false }, 'allow'],
      ['edit_file existing file', 'edit_file', { Path: existingFile, Target: 'Hello', Replacement: 'Hi' }, 'allow'],
      ['legacy view_file', 'view_file', { AbsolutePath: existingFile }, 'allow'],
      ['legacy write_to_file', 'write_to_file', { TargetFile: newFileInSubdir }, 'allow'],
      ['legacy replace_file_content', 'replace_file_content', { TargetFile: existingFile }, 'allow'],

      // Missing/invalid required modern fields, unknown fields, metadata, safe integers, non-object args
      ['read_file null args', 'read_file', null, 'deny'],
      ['read_file array args', 'read_file', [], 'deny'],
      ['read_file missing Path', 'read_file', {}, 'deny'],
      ['read_file relative Path', 'read_file', { Path: 'hello.txt' }, 'deny'],
      ['read_file unknown field', 'read_file', { Path: existingFile, Extra: 1 }, 'deny'],
      ['read_file invalid toolSummary type', 'read_file', { Path: existingFile, toolSummary: 123 }, 'deny'],
      ['read_file oversized toolAction', 'read_file', { Path: existingFile, toolAction: 'x'.repeat(2001) }, 'deny'],
      ['read_file StartLine 0', 'read_file', { Path: existingFile, StartLine: 0 }, 'deny'],
      ['read_file StartLine float', 'read_file', { Path: existingFile, StartLine: 1.5 }, 'deny'],
      ['read_file StartLine unsafe int', 'read_file', { Path: existingFile, StartLine: unsafeInt }, 'deny'],
      ['read_file ByteOffset negative', 'read_file', { Path: existingFile, ByteOffset: -1 }, 'deny'],
      ['read_file ByteOffset unsafe int', 'read_file', { Path: existingFile, ByteOffset: unsafeInt }, 'deny'],
      ['read_file StartLine > EndLine', 'read_file', { Path: existingFile, StartLine: 10, EndLine: 2 }, 'deny'],
      ['write_file missing Content', 'write_file', { Path: existingFile }, 'deny'],
      ['write_file null Content', 'write_file', { Path: existingFile, Content: null }, 'deny'],
      ['write_file non-string Content', 'write_file', { Path: existingFile, Content: 123 }, 'deny'],
      ['write_file legacy CodeContent field', 'write_file', { Path: existingFile, Content: 'a', CodeContent: 'a' }, 'deny'],
      ['write_file invalid Overwrite type', 'write_file', { Path: existingFile, Content: 'a', Overwrite: 'yes' }, 'deny'],
      ['write_file conflicting Append and Overwrite', 'write_file', { Path: existingFile, Content: 'a', Append: true, Overwrite: true }, 'deny'],
      ['write_file null ArtifactMetadata', 'write_file', { Path: existingFile, Content: 'a', ArtifactMetadata: null }, 'deny'],
      ['write_file array ArtifactMetadata', 'write_file', { Path: existingFile, Content: 'a', ArtifactMetadata: [] }, 'deny'],
      ['edit_file missing Target', 'edit_file', { Path: existingFile, Replacement: 'b' }, 'deny'],
      ['edit_file missing Replacement', 'edit_file', { Path: existingFile, Target: 'a' }, 'deny'],
      ['edit_file null Target', 'edit_file', { Path: existingFile, Target: null, Replacement: 'b' }, 'deny'],
      ['edit_file non-string Replacement', 'edit_file', { Path: existingFile, Target: 'a', Replacement: 42 }, 'deny'],
      ['edit_file legacy ReplacementChunks field', 'edit_file', { Path: existingFile, Target: 'a', Replacement: 'b', ReplacementChunks: [] }, 'deny'],

      // Conflicting or ambiguous legacy/modern targets
      ['read_file legacy AbsolutePath only', 'read_file', { AbsolutePath: existingFile }, 'deny'],
      ['read_file conflicting Path and AbsolutePath', 'read_file', { Path: existingFile, AbsolutePath: outsideFile }, 'deny'],
      ['read_file ambiguous identical Path and AbsolutePath', 'read_file', { Path: existingFile, AbsolutePath: existingFile }, 'deny'],
      ['write_file conflicting Path and TargetFile', 'write_file', { Path: existingFile, TargetFile: outsideFile, Content: 'x' }, 'deny'],
      ['edit_file legacy TargetFile only', 'edit_file', { TargetFile: existingFile, Target: 'Hello', Replacement: 'Hi' }, 'deny'],
      ['legacy view_file with modern Path', 'view_file', { AbsolutePath: existingFile, Path: outsideFile }, 'deny'],
      ['legacy write_to_file with modern Path', 'write_to_file', { TargetFile: existingFile, Path: existingFile }, 'deny'],

      // Path, .git, .agents, Windows aliases, hardlinks, symlinks, missing targets
      ['read_file missing target file', 'read_file', { Path: missingFile }, 'deny'],
      ['edit_file missing target file', 'edit_file', { Path: missingFile, Target: 'a', Replacement: 'b' }, 'deny'],
      ['read_file outside copy', 'read_file', { Path: outsideFile }, 'deny'],
      ['write_file outside copy', 'write_file', { Path: outsideFile, Content: 'x' }, 'deny'],
      ['edit_file outside copy', 'edit_file', { Path: outsideFile, Target: 'Outside', Replacement: 'In' }, 'deny'],
      ['read_file .git', 'read_file', { Path: gitConfig }, 'deny'],
      ['write_file .git', 'write_file', { Path: gitConfig, Content: 'x' }, 'deny'],
      ['edit_file .git', 'edit_file', { Path: gitConfig, Target: 'core', Replacement: 'x' }, 'deny'],
      ['read_file protected .agents hook', 'read_file', { Path: path.join(agentsDir, 'bridge-execution-hook.mjs') }, 'deny'],
      ['write_file .agents skill file', 'write_file', { Path: skillFile, Content: 'pwn' }, 'deny'],
      ['edit_file .agents skill file', 'edit_file', { Path: skillFile, Target: 'Body', Replacement: 'pwn' }, 'deny'],
      ['write_file root node.exe', 'write_file', { Path: path.join(copyDir, 'node.exe'), Content: 'x' }, 'deny'],
      ['write_file Windows device name CON.txt', 'write_file', { Path: path.join(copyDir, 'CON.txt'), Content: 'x' }, 'deny'],
      ['read_file hardlinked file', 'read_file', { Path: hardlinkDst }, 'deny'],
      ['write_file hardlinked file', 'write_file', { Path: hardlinkDst, Content: 'x' }, 'deny'],
      ['edit_file hardlinked file', 'edit_file', { Path: hardlinkDst, Target: 'Hardlink', Replacement: 'x' }, 'deny'],
      ['read_file symlinked ancestry', 'read_file', { Path: path.join(symlinkDir, 'secret.txt') }, 'deny'],
      ['write_file symlinked ancestry', 'write_file', { Path: path.join(symlinkDir, 'new.txt'), Content: 'x' }, 'deny'],
      ['edit_file symlinked ancestry', 'edit_file', { Path: path.join(symlinkDir, 'secret.txt'), Target: 'Secret', Replacement: 'x' }, 'deny'],
    ];

    for (const [label, name, args, expected] of cases) {
      const res = await runHook(agentsDir, { toolCall: { name, args }, conversationId });
      assert.equal(res.exitCode, 0, `${label}: expected exitCode 0`);
      assert.equal(res.decision, expected, `${label}: unexpected decision (${res.reason})`);
    }

    const receiptEntries = (await readFile(stagedFull.receiptPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(receiptEntries.length, cases.length);
    assert.equal(receiptEntries[0].toolName, 'read_file');
    assert.equal(receiptEntries[0].decision, 'allow');
    assert.equal(receiptEntries[3].toolName, 'write_file');
    assert.equal(receiptEntries[3].decision, 'allow');
    assert.equal(receiptEntries[5].toolName, 'edit_file');
    assert.equal(receiptEntries[5].decision, 'allow');
    assert.equal(receiptEntries[6].toolName, 'view_file');
    assert.equal(receiptEntries[6].decision, 'allow');

    await clearFixturePolicy(stagedFull);

    // Stage 2: write_to_file without replace/multi_replace does NOT authorize edit_file
    const execWriteOnly = randomUUID();
    const stagedWriteOnly = await stageExecutionPolicy(
      copyDir,
      {
        policy: resolveAgentPolicy(
          { allowedTools: ['finish', 'view_file', 'write_to_file'], mcpServers: [] },
          ['finish', 'view_file', 'write_to_file'],
          catalog,
          'write',
          execWriteOnly
        ),
        catalog,
        stateDirectory: stateDir,
        executionId: execWriteOnly,
        skillFiles: [],
      },
      DEFAULT_PROJECT_LIMITS
    );

    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'write_file', args: { Path: existingFile, Content: 'ok' } }, conversationId })).decision,
      'allow'
    );
    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'edit_file', args: { Path: existingFile, Target: 'Hello', Replacement: 'Hi' } }, conversationId })).decision,
      'deny'
    );
    await clearFixturePolicy(stagedWriteOnly);

    // Stage 3: multi_replace_file_content authorizes edit_file without granting write_file or read_file
    const execMultiEdit = randomUUID();
    const stagedMultiEdit = await stageExecutionPolicy(
      copyDir,
      {
        policy: resolveAgentPolicy(
          { allowedTools: ['finish', 'multi_replace_file_content'], mcpServers: [] },
          ['finish', 'multi_replace_file_content'],
          catalog,
          'write',
          execMultiEdit
        ),
        catalog,
        stateDirectory: stateDir,
        executionId: execMultiEdit,
        skillFiles: [],
      },
      DEFAULT_PROJECT_LIMITS
    );

    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'edit_file', args: { Path: existingFile, Target: 'Hello', Replacement: 'Hi' } }, conversationId })).decision,
      'allow'
    );
    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'write_file', args: { Path: existingFile, Content: 'no' } }, conversationId })).decision,
      'deny'
    );
    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'read_file', args: { Path: existingFile } }, conversationId })).decision,
      'deny'
    );
    await clearFixturePolicy(stagedMultiEdit);

    // Stage 4: read-only mode rejects write capabilities at policy admission and denies write_file/edit_file in hook
    assert.throws(() =>
      resolveAgentPolicy(
        { allowedTools: ['finish', 'view_file', 'write_to_file'], mcpServers: [] },
        ['finish', 'view_file', 'write_to_file'],
        catalog,
        'read-only',
        randomUUID()
      )
    );

    const execReadOnly = randomUUID();
    const stagedReadOnly = await stageExecutionPolicy(
      copyDir,
      {
        policy: resolveAgentPolicy(
          { allowedTools: ['finish', 'view_file'], mcpServers: [] },
          ['finish', 'view_file'],
          catalog,
          'read-only',
          execReadOnly
        ),
        catalog,
        stateDirectory: stateDir,
        executionId: execReadOnly,
        skillFiles: [],
      },
      DEFAULT_PROJECT_LIMITS
    );

    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'read_file', args: { Path: existingFile } }, conversationId })).decision,
      'allow'
    );
    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'write_file', args: { Path: existingFile, Content: 'no' } }, conversationId })).decision,
      'deny'
    );
    assert.equal(
      (await runHook(agentsDir, { toolCall: { name: 'edit_file', args: { Path: existingFile, Target: 'Hello', Replacement: 'Hi' } }, conversationId })).decision,
      'deny'
    );
    await clearFixturePolicy(stagedReadOnly);
  } finally {
    await removeFixture(copyDir);
    await removeFixture(stateDir);
  }
});
