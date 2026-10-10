import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, lstat, symlink, rename, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  stageExecutionPolicy,
  verifyExecutionPolicy,
  readExecutionPolicyReceipt,
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
