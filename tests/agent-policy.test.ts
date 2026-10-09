import path from 'node:path';
import { BridgeError } from '../src/types.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  mcpCatalogSchema,
  mcpCatalogEntrySchema,
  mcpSelectionSchema,
  nativeToolsSchema,
  agentPolicySelectionSchema,
  resolveAgentPolicy,
  authorizeMcpTool,
  type McpCatalogEntry,
  type AgentPolicySelection,
  type NativeTool,
} from '../src/agent-policy.js';

describe('agent-policy: catalog validation and transport bounds', () => {
  const baseTools = [
    { name: 'read_query', readOnly: true },
    { name: 'execute_mutation', readOnly: false },
  ];

  const validEntries: Array<{ name: string; entry: McpCatalogEntry }> = [
    {
      name: 'valid stdio transport with command, args, cwd, and env',
      entry: {
        id: 'local-runner',
        description: 'Local stdio tool runner',
        command: process.platform === 'win32' ? 'C:\\tools\\runner.exe' : '/usr/bin/runner',
        args: ['--mode', 'batch', '--verbose'],
        cwd: process.platform === 'win32' ? 'C:\\tools' : '/usr/bin',
        env: { RUNNER_ENV: 'production', LOG_LEVEL: 'info' },
        tools: baseTools,
      },
    },
    {
      name: 'valid remote HTTPS transport with headers',
      entry: {
        id: 'remote-api',
        serverUrl: 'https://api.internal.example.com/mcp',
        headers: { 'X-Bridge-Token': 'secret-auth-value' },
        tools: baseTools,
      },
    },
    {
      name: 'valid loopback HTTP localhost',
      entry: {
        id: 'loopback-localhost',
        serverUrl: 'http://localhost:8080/mcp',
        tools: baseTools,
      },
    },
    {
      name: 'valid loopback HTTP 127.0.0.1',
      entry: {
        id: 'loopback-ipv4',
        serverUrl: 'http://127.0.0.1:9090/mcp',
        tools: baseTools,
      },
    },
    {
      name: 'valid loopback HTTP [::1]',
      entry: {
        id: 'loopback-ipv6',
        serverUrl: 'http://[::1]:9090/mcp',
        tools: baseTools,
      },
    },
  ];

  for (const { name, entry } of validEntries) {
    it(`accepts ${name}`, () => {
      const result = mcpCatalogSchema.safeParse([entry]);
      assert.equal(result.success, true);
    });
  }

  const invalidEntries: Array<{ reason: string; entry: unknown }> = [
    {
      reason: 'both command and serverUrl are provided',
      entry: {
        id: 'dual-transport',
        command: path.resolve('fixtures/tool'),
        serverUrl: 'https://api.example.com',
        tools: baseTools,
      },
    },
    {
      reason: 'neither command nor serverUrl is provided',
      entry: {
        id: 'no-transport',
        tools: baseTools,
      },
    },
    {
      reason: 'HTTP transport specifies stdio-only args',
      entry: {
        id: 'http-with-args',
        serverUrl: 'https://api.example.com',
        args: ['--arg'],
        tools: baseTools,
      },
    },
    {
      reason: 'HTTP transport specifies stdio-only cwd',
      entry: {
        id: 'http-with-cwd',
        serverUrl: 'https://api.example.com',
        cwd: path.resolve('fixtures/cwd'),
        tools: baseTools,
      },
    },
    {
      reason: 'HTTP transport specifies stdio-only env',
      entry: {
        id: 'http-with-env',
        serverUrl: 'https://api.example.com',
        env: { FOO: 'bar' },
        tools: baseTools,
      },
    },
    {
      reason: 'stdio transport specifies HTTP headers',
      entry: {
        id: 'stdio-with-headers',
        command: path.resolve('fixtures/tool'),
        headers: { 'X-Custom': 'val' },
        tools: baseTools,
      },
    },
    {
      reason: 'remote HTTP is not HTTPS and not loopback',
      entry: {
        id: 'remote-plain-http',
        serverUrl: 'http://external.example.com/mcp',
        tools: baseTools,
      },
    },
    {
      reason: 'HTTP URL has embedded credentials',
      entry: {
        id: 'http-credentials',
        serverUrl: 'http://user:pass@localhost:8080/mcp',
        tools: baseTools,
      },
    },
    {
      reason: 'HTTPS URL has embedded credentials',
      entry: {
        id: 'https-credentials',
        serverUrl: 'https://user:pass@api.example.com/mcp',
        tools: baseTools,
      },
    },
    {
      reason: 'disallowed URL protocol ftp:',
      entry: {
        id: 'ftp-url',
        serverUrl: 'ftp://localhost:8080/mcp',
        tools: baseTools,
      },
    },
    {
      reason: 'relative command path',
      entry: {
        id: 'rel-cmd',
        command: 'relative/bin/tool',
        tools: baseTools,
      },
    },
    {
      reason: 'relative cwd path',
      entry: {
        id: 'rel-cwd',
        command: path.resolve('fixtures/tool'),
        cwd: './relative-dir',
        tools: baseTools,
      },
    },
    {
      reason: 'invalid serverId with uppercase characters',
      entry: {
        id: 'Invalid-ID',
        command: path.resolve('fixtures/tool'),
        tools: baseTools,
      },
    },
    {
      reason: 'invalid serverId starting with number',
      entry: {
        id: '1server',
        command: path.resolve('fixtures/tool'),
        tools: baseTools,
      },
    },
    {
      reason: 'empty tools array',
      entry: {
        id: 'empty-tools',
        command: path.resolve('fixtures/tool'),
        tools: [],
      },
    },
    {
      reason: 'duplicate tool names within single catalog entry',
      entry: {
        id: 'dup-tools',
        command: path.resolve('fixtures/tool'),
        tools: [
          { name: 'echo', readOnly: true },
          { name: 'echo', readOnly: false },
        ],
      },
    },
    {
      reason: 'invalid tool name format',
      entry: {
        id: 'bad-tool-name',
        command: path.resolve('fixtures/tool'),
        tools: [{ name: '-invalid-name', readOnly: true }],
      },
    },
    {
      reason: 'description exceeding 500 characters',
      entry: {
        id: 'long-desc',
        description: 'a'.repeat(501),
        command: path.resolve('fixtures/tool'),
        tools: baseTools,
      },
    },
    {
      reason: 'env key with hyphens',
      entry: {
        id: 'bad-env-key',
        command: path.resolve('fixtures/tool'),
        env: { 'BAD-KEY': 'value' },
        tools: baseTools,
      },
    },
  ];

  for (const { reason, entry } of invalidEntries) {
    it(`rejects catalog entry when ${reason}`, () => {
      const result = mcpCatalogSchema.safeParse([entry]);
      assert.equal(result.success, false);
    });
  }

  it('rejects duplicate serverId in catalog', () => {
    const entry1: McpCatalogEntry = {
      id: 'duplicate-server',
      command: path.resolve('fixtures/tool1'),
      tools: baseTools,
    };
    const entry2: McpCatalogEntry = {
      id: 'duplicate-server',
      command: path.resolve('fixtures/tool2'),
      tools: baseTools,
    };
    const result = mcpCatalogSchema.safeParse([entry1, entry2]);
    assert.equal(result.success, false);
  });

  it('rejects catalog with more than 20 servers', () => {
    const entries: McpCatalogEntry[] = Array.from({ length: 21 }, (_, i) => ({
      id: `srv-${i}`,
      command: path.resolve('fixtures/tool'),
      tools: baseTools,
    }));
    const result = mcpCatalogSchema.safeParse(entries);
    assert.equal(result.success, false);
  });
});

describe('agent-policy: selection schema bounds', () => {
  it('validates nativeToolsSchema constraints', () => {
    // Empty array allowed
    assert.equal(nativeToolsSchema.safeParse([]).success, true);
    // Max 5 allowed
    assert.equal(
      nativeToolsSchema.safeParse([
        'finish',
        'view_file',
        'write_to_file',
        'replace_file_content',
        'multi_replace_file_content',
      ]).success,
      true
    );
    // Duplicate rejected
    assert.equal(nativeToolsSchema.safeParse(['finish', 'finish']).success, false);
    // Unknown tool rejected
    assert.equal(nativeToolsSchema.safeParse(['run_shell']).success, false);
  });

  it('validates mcpSelectionSchema constraints', () => {
    // Valid selection
    assert.equal(
      mcpSelectionSchema.safeParse([
        { serverId: 'db-srv', tools: ['query'] },
        { serverId: 'cache-srv' },
      ]).success,
      true
    );
    // Duplicate serverId rejected
    assert.equal(
      mcpSelectionSchema.safeParse([
        { serverId: 'db-srv', tools: ['query'] },
        { serverId: 'db-srv', tools: ['mutate'] },
      ]).success,
      false
    );
    // Duplicate tool names in tools rejected
    assert.equal(
      mcpSelectionSchema.safeParse([
        { serverId: 'db-srv', tools: ['query', 'query'] },
      ]).success,
      false
    );
    // > 20 servers rejected
    const oversized = Array.from({ length: 21 }, (_, i) => ({
      serverId: `server-${i}`,
    }));
    assert.equal(mcpSelectionSchema.safeParse(oversized).success, false);
  });

  it('rejects extra fields on agentPolicySelectionSchema (strict object)', () => {
    assert.equal(
      agentPolicySelectionSchema.safeParse({
        allowedTools: ['finish'],
        extraPrivilege: true,
      }).success,
      false
    );
  });
});

describe('agent-policy: resolveAgentPolicy ceilings, narrowing, and read-only protection', () => {
  const catalog: McpCatalogEntry[] = [
    {
      id: 'fs-probe',
      command: path.resolve('fixtures/fs-probe'),
      description: 'Filesystem probe',
      tools: [
        { name: 'read_file', readOnly: true },
        { name: 'write_file', readOnly: false },
      ],
    },
    {
      id: 'readonly-only',
      command: path.resolve('fixtures/ro'),
      tools: [{ name: 'inspect', readOnly: true }],
    },
    {
      id: 'mutation-only',
      command: path.resolve('fixtures/rw'),
      tools: [{ name: 'modify', readOnly: false }],
    },
  ];

  const validUuid = '123e4567-e89b-12d3-a456-426614174000';

  it('narrows native tools to human ceiling and retains implicit finish', () => {
    const ceiling: NativeTool[] = ['view_file', 'write_to_file'];
    const selection: AgentPolicySelection = {
      allowedTools: ['view_file'],
    };

    const policy = resolveAgentPolicy(selection, ceiling, catalog, 'write', validUuid);
    assert.deepEqual(policy.nativeTools, ['view_file', 'finish']);
    assert.equal(policy.mode, 'write');
  });

  it('always includes finish even when human ceiling omitted it', () => {
    const ceiling: NativeTool[] = ['view_file'];
    const selection: AgentPolicySelection = {};

    const policy = resolveAgentPolicy(selection, ceiling, catalog, 'write', validUuid);
    assert.ok(policy.nativeTools.includes('finish'));
    assert.ok(policy.nativeTools.includes('view_file'));
  });

  it('missing allowedTools in read-only filters ceiling to finish and view_file', () => {
    const ceiling: NativeTool[] = [
      'finish',
      'view_file',
      'write_to_file',
      'replace_file_content',
    ];
    const selection: AgentPolicySelection = {};

    const policy = resolveAgentPolicy(selection, ceiling, catalog, 'read-only', validUuid);
    assert.deepEqual(policy.nativeTools, ['finish', 'view_file']);
  });

  it('explicit tool beyond ceiling throws BridgeError(POLICY_NOT_ALLOWED)', () => {
    const ceiling: NativeTool[] = ['finish', 'view_file'];
    const selection: AgentPolicySelection = {
      allowedTools: ['finish', 'write_to_file'],
    };

    assert.throws(
      () => resolveAgentPolicy(selection, ceiling, catalog, 'write', validUuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('explicit write tools in read-only mode throws BridgeError(POLICY_NOT_ALLOWED)', () => {
    const ceiling: NativeTool[] = ['finish', 'view_file', 'write_to_file'];
    const selection: AgentPolicySelection = {
      allowedTools: ['finish', 'write_to_file'],
    };

    assert.throws(
      () => resolveAgentPolicy(selection, ceiling, catalog, 'read-only', validUuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('rejects invalid namespace UUID syntax', () => {
    const ceiling: NativeTool[] = ['finish'];
    assert.throws(
      () => resolveAgentPolicy({}, ceiling, catalog, 'write', 'not-a-uuid'),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('rejects invalid mode', () => {
    const ceiling: NativeTool[] = ['finish'];
    assert.throws(
      () => resolveAgentPolicy({}, ceiling, catalog, 'invalid' as any, validUuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });
});

describe('agent-policy: MCP server resolution, mapping, and read-only tools', () => {
  const catalog: McpCatalogEntry[] = [
    {
      id: 'fs-probe',
      command: path.resolve('fixtures/fs-probe'),
      tools: [
        { name: 'read_tree', readOnly: true },
        { name: 'delete_tree', readOnly: false },
      ],
    },
    {
      id: 'mutate-only',
      command: path.resolve('fixtures/mut'),
      tools: [{ name: 'apply_patch', readOnly: false }],
    },
  ];

  const uuid = '550e8400-e29b-41d4-a716-446655440000';

  it('maps native serverName avoiding collisions', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'fs-probe', tools: ['read_tree'] }],
    };
    const policy = resolveAgentPolicy(selection, ['finish'], catalog, 'write', uuid);
    assert.equal(policy.mcpServers.length, 1);
    assert.equal(policy.mcpServers[0]?.serverId, 'fs-probe');
    assert.equal(
      policy.mcpServers[0]?.serverName,
      'bridge_550e8400e29b41d4a716446655440000_fs_probe'
    );
    assert.deepEqual(policy.mcpServers[0]?.tools, ['read_tree']);
  });

  it('selection without tools in write mode includes all catalog tools', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'fs-probe' }],
    };
    const policy = resolveAgentPolicy(selection, ['finish'], catalog, 'write', uuid);
    assert.deepEqual(policy.mcpServers[0]?.tools, ['read_tree', 'delete_tree']);
  });

  it('selection without tools in read-only mode includes only readOnly tools', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'fs-probe' }],
    };
    const policy = resolveAgentPolicy(selection, ['finish'], catalog, 'read-only', uuid);
    assert.deepEqual(policy.mcpServers[0]?.tools, ['read_tree']);
  });

  it('selection without tools in read-only mode fails when server has no readOnly tools', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'mutate-only' }],
    };
    assert.throws(
      () => resolveAgentPolicy(selection, ['finish'], catalog, 'read-only', uuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('explicit non-readOnly tool in read-only mode throws BridgeError(POLICY_NOT_ALLOWED)', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'fs-probe', tools: ['delete_tree'] }],
    };
    assert.throws(
      () => resolveAgentPolicy(selection, ['finish'], catalog, 'read-only', uuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('unknown serverId throws BridgeError(POLICY_NOT_ALLOWED)', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'unregistered-server' }],
    };
    assert.throws(
      () => resolveAgentPolicy(selection, ['finish'], catalog, 'write', uuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('unknown tool name throws BridgeError(POLICY_NOT_ALLOWED)', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'fs-probe', tools: ['unknown_action'] }],
    };
    assert.throws(
      () => resolveAgentPolicy(selection, ['finish'], catalog, 'write', uuid),
      (err) => err instanceof BridgeError && err.code === 'POLICY_NOT_ALLOWED'
    );
  });

  it('missing mcpServers yields empty mcpServers list', () => {
    const selection: AgentPolicySelection = {};
    const policy = resolveAgentPolicy(selection, ['finish'], catalog, 'write', uuid);
    assert.deepEqual(policy.mcpServers, []);
  });
});

describe('agent-policy: secrets exposure and hash verification', () => {
  const secretCommand = path.resolve('fixtures/opaque-server');
  const secretArg = '--token=SUPER_SECRET_TOKEN_999';
  const secretEnvVal = 'PRIVATE_DATABASE_KEY_xyz123';
  const secretHeaderVal = 'Bearer ConfidentialSecretToken';
  const secretDesc = 'Confidential human-only catalog server';

  const secretCatalog: McpCatalogEntry[] = [
    {
      id: 'secure-vault',
      description: secretDesc,
      command: secretCommand,
      args: ['--addr', '127.0.0.1', secretArg],
      env: { VAULT_SECRET_KEY: secretEnvVal },
      cwd: path.resolve('fixtures/cwd'),
      tools: [{ name: 'get_secret', readOnly: true }],
    },
    {
      id: 'http-vault',
      serverUrl: 'https://vault.internal.net/mcp',
      headers: { Authorization: secretHeaderVal },
      tools: [{ name: 'ping', readOnly: true }],
    },
  ];

  const uuid = 'a0b1c2d3-e4f5-4a5b-8c9d-0e1f2a3b4c5d';

  it('never leaks commands, args, env, headers, descriptions, or secrets in returned policy', () => {
    const selection: AgentPolicySelection = {
      allowedTools: ['finish', 'view_file'],
      mcpServers: [{ serverId: 'secure-vault' }, { serverId: 'http-vault' }],
    };

    const policy = resolveAgentPolicy(
      selection,
      ['finish', 'view_file'],
      secretCatalog,
      'read-only',
      uuid
    );

    const serializedPolicy = JSON.stringify(policy);

    assert.equal(serializedPolicy.includes(secretCommand), false);
    assert.equal(serializedPolicy.includes(secretArg), false);
    assert.equal(serializedPolicy.includes(secretEnvVal), false);
    assert.equal(serializedPolicy.includes(secretHeaderVal), false);
    assert.equal(serializedPolicy.includes(secretDesc), false);
    assert.equal(serializedPolicy.includes('VAULT_SECRET_KEY'), false);
    assert.equal(serializedPolicy.includes('Authorization'), false);

    const policyKeys = Object.keys(policy).sort();
    assert.deepEqual(policyKeys, [
      'catalogSha256',
      'mcpServers',
      'mode',
      'nativeTools',
      'sha256',
    ]);

    for (const server of policy.mcpServers) {
      assert.deepEqual(Object.keys(server).sort(), [
        'serverId',
        'serverName',
        'tools',
      ]);
    }
  });

  it('computes catalogSha256 and sha256 matching independent node:crypto calculation', () => {
    const selection: AgentPolicySelection = {
      mcpServers: [{ serverId: 'secure-vault' }],
    };

    const policy = resolveAgentPolicy(
      selection,
      ['finish'],
      secretCatalog,
      'read-only',
      uuid
    );

    // Independent expected catalogSha256 of selected private definitions
    const expectedSelectedPrivate = [secretCatalog[0]];
    const expectedCatalogSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(expectedSelectedPrivate))
      .digest('hex');

    assert.equal(policy.catalogSha256, expectedCatalogSha256);

    // Independent expected sha256 of public payload excluding sha256
    const expectedPublic = {
      mode: policy.mode,
      nativeTools: policy.nativeTools,
      mcpServers: policy.mcpServers,
      catalogSha256: expectedCatalogSha256,
    };
    const expectedSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(expectedPublic))
      .digest('hex');

    assert.equal(policy.sha256, expectedSha256);
  });
});

describe('agent-policy: mutation immunity', () => {
  const uuid = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('ensures input mutations after resolution do not affect policy', () => {
    const ceiling: NativeTool[] = ['finish', 'view_file'];
    const selection: AgentPolicySelection = {
      allowedTools: ['view_file'],
      mcpServers: [{ serverId: 'probe', tools: ['echo'] }],
    };
    const catalog: McpCatalogEntry[] = [
      {
        id: 'probe',
        command: path.resolve('fixtures/probe'),
        tools: [{ name: 'echo', readOnly: true }],
      },
    ];

    const policy = resolveAgentPolicy(selection, ceiling, catalog, 'write', uuid);

    // Mutate inputs
    ceiling.push('write_to_file');
    selection.allowedTools?.push('write_to_file');
    catalog[0]!.tools.push({ name: 'dangerous_tool', readOnly: false });

    // Assert policy arrays were not modified
    assert.deepEqual(policy.nativeTools, ['view_file', 'finish']);
    assert.deepEqual(policy.mcpServers[0]?.tools, ['echo']);
  });

  it('ensures output mutations do not affect internal state or subsequent checks', () => {
    const catalog: McpCatalogEntry[] = [
      {
        id: 'probe',
        command: path.resolve('fixtures/probe'),
        tools: [{ name: 'echo', readOnly: true }],
      },
    ];

    const ceiling: NativeTool[] = ['finish'];
    const selection: AgentPolicySelection = {mcpServers:[{serverId:'probe',tools:['echo']}]};
    const policy = resolveAgentPolicy(selection, ceiling, catalog, 'write', uuid);
    policy.nativeTools.push('write_to_file');
    policy.mcpServers[0]!.tools.push('unapproved');
    assert.deepEqual(ceiling,['finish']);
    assert.deepEqual(selection.mcpServers![0]!.tools,['echo']);
    assert.deepEqual(catalog[0]!.tools,[{name:'echo',readOnly:true}]);
    const policy2 = resolveAgentPolicy(selection, ceiling, catalog, 'write', uuid);
    assert.deepEqual(policy2.nativeTools, ['finish']);
    assert.deepEqual(policy2.mcpServers[0]!.tools,['echo']);
  });
});

describe('agent-policy: authorizeMcpTool exact generic authorization', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const catalog: McpCatalogEntry[] = [
    {
      id: 'test-server',
      command: path.resolve('fixtures/test-server'),
      tools: [
        { name: 'allowed_tool', readOnly: true },
        { name: 'write_tool', readOnly: false },
      ],
    },
  ];

  const policy = resolveAgentPolicy(
    { mcpServers: [{ serverId: 'test-server', tools: ['allowed_tool'] }] },
    ['finish'],
    catalog,
    'write',
    uuid
  );

  const nativeServerName = 'bridge_123e4567e89b12d3a456426614174000_test_server';

  it('authorizes valid call with exact native serverName, allowed tool, and valid JSON arguments', () => {
    const validCall = {
      ServerName: nativeServerName,
      ToolName: 'allowed_tool',
      Arguments: { query: 'test', limit: 10, flags: [true, false], sub: { ok: null } },
    };
    assert.equal(authorizeMcpTool(policy, validCall), true);
  });

  const unauthorizedCalls: Array<{ reason: string; call: unknown }> = [
    {
      reason: 'serverId used instead of native serverName',
      call: {
        ServerName: 'test-server',
        ToolName: 'allowed_tool',
        Arguments: {},
      },
    },
    {
      reason: 'unknown native serverName',
      call: {
        ServerName: 'bridge_wrong_server',
        ToolName: 'allowed_tool',
        Arguments: {},
      },
    },
    {
      reason: 'tool not in policy allowed tools list',
      call: {
        ServerName: nativeServerName,
        ToolName: 'write_tool',
        Arguments: {},
      },
    },
    {
      reason: 'wrong-case serverName field',
      call: {
        serverName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: {},
      },
    },
    {
      reason: 'wrong-case toolName field',
      call: {
        ServerName: nativeServerName,
        toolName: 'allowed_tool',
        Arguments: {},
      },
    },
    {
      reason: 'wrong-case arguments field',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        arguments: {},
      },
    },
    {
      reason: 'missing Arguments field',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
      },
    },
    {
      reason: 'missing ToolName field',
      call: {
        ServerName: nativeServerName,
        Arguments: {},
      },
    },
    {
      reason: 'missing ServerName field',
      call: {
        ToolName: 'allowed_tool',
        Arguments: {},
      },
    },
    {
      reason: 'privilege expansion with extra properties on call',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: {},
        grantAccess: true,
      },
    },
    {
      reason: 'Arguments is array instead of JSON object',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: ['arg1'],
      },
    },
    {
      reason: 'Arguments is null',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: null,
      },
    },
    {
      reason: 'Arguments is primitive string',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: 'string',
      },
    },
    {
      reason: 'Arguments contains NaN',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: { val: NaN },
      },
    },
    {
      reason: 'Arguments contains Infinity',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: { val: Infinity },
      },
    },
    {
      reason: 'Arguments contains undefined value',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: { val: undefined },
      },
    },
    {
      reason: 'Arguments contains a function',
      call: {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: { fn: () => {} },
      },
    },
  ];

  for (const { reason, call } of unauthorizedCalls) {
    it(`denies authorization when ${reason}`, () => {
      assert.equal(authorizeMcpTool(policy, call), false);
    });
  }

  it('denies circular object in Arguments', () => {
    const circularArgs: Record<string, unknown> = { key: 'value' };
    circularArgs['self'] = circularArgs;

    assert.equal(
      authorizeMcpTool(policy, {
        ServerName: nativeServerName,
        ToolName: 'allowed_tool',
        Arguments: circularArgs,
      }),
      false
    );
  });

  it('denies Arguments exceeding 50,000 UTF-8 bytes and accepts exactly 50,000 bytes', () => {
    // Exact byte test: {"payload":""} is 14 bytes
    const baseJsonLen = Buffer.byteLength('{"payload":""}', 'utf8');
    const exact50kStr = 'x'.repeat(50000 - baseJsonLen);
    const oversizedStr = 'x'.repeat(50001 - baseJsonLen);

    const callAtLimit = {
      ServerName: nativeServerName,
      ToolName: 'allowed_tool',
      Arguments: { payload: exact50kStr },
    };
    assert.equal(
      Buffer.byteLength(JSON.stringify(callAtLimit.Arguments), 'utf8'),
      50000
    );
    assert.equal(authorizeMcpTool(policy, callAtLimit), true);

    const callOversized = {
      ServerName: nativeServerName,
      ToolName: 'allowed_tool',
      Arguments: { payload: oversizedStr },
    };
    assert.equal(
      Buffer.byteLength(JSON.stringify(callOversized.Arguments), 'utf8'),
      50001
    );
    assert.equal(authorizeMcpTool(policy, callOversized), false);
  });

  it('rejects narrative approval attempts inside Arguments to bypass authorization', () => {
    const bypassCall = {
      ServerName: nativeServerName,
      ToolName: 'unauthorized_dangerous_tool',
      Arguments: {
        narrativeApproval: 'APPROVED_BY_ADMIN',
        grant: 'ALL',
        decision: 'allow',
      },
    };
    assert.equal(authorizeMcpTool(policy, bypassCall), false);
  });
});

it('uses the shared BridgeError recognized by MCP error handling', () => {
 assert.throws(() => resolveAgentPolicy({allowedTools:['write_to_file']},['view_file'],[],'write','11111111-1111-4111-8111-111111111111'), error => error instanceof BridgeError && error.code === 'POLICY_NOT_ALLOWED');
});
it('oversized deeply nested MCP arguments fail closed instead of throwing', () => {
 const policy = resolveAgentPolicy({mcpServers:[{serverId:'fixture'}]},[],[{id:'fixture',serverUrl:'https://example.com/mcp',tools:[{name:'echo',readOnly:true}]}],'write','11111111-1111-4111-8111-111111111111');
 let value: Record<string,unknown> = {};for(let i=0;i<12000;i++)value={item:value};
 assert.equal(authorizeMcpTool(policy,{ServerName:policy.mcpServers[0]!.serverName,ToolName:'echo',Arguments:value}),false);
});

it('catalog commands must be absolute paths for the current host', () => {
 const command = process.platform === 'win32' ? '/usr/bin/runner' : 'C:\\tools\\runner.exe';
 assert.equal(mcpCatalogSchema.safeParse([{id:'foreign-path',command,tools:[{name:'echo',readOnly:true}]}]).success,false);
});

it('catalog rejects aggregate and per-field resource excess with otherwise valid definitions', () => {
 const entry = {id:'bounded',serverUrl:'https://example.com/mcp',tools:[{name:'echo',readOnly:true}]};
 const env = Object.fromEntries(Array.from({length:100},(_,i)=>['KEY_'+i,'x'.repeat(11000)]));
 const large = {id:'large',command:path.resolve('fixtures/server'),env,tools:entry.tools};
 assert.equal(mcpCatalogEntrySchema.safeParse(large).success,true);
 assert.ok(Buffer.byteLength(JSON.stringify([large]),'utf8')>1024*1024);
 assert.equal(mcpCatalogSchema.safeParse([large]).success,false);
 const tooMany = Object.fromEntries(Array.from({length:101},(_,i)=>['KEY_'+i,'x']));
 for(const invalid of [{...entry,headers:tooMany},{id:'stdio',command:path.resolve('fixtures/server'),env:tooMany,tools:entry.tools},{id:'args',command:path.resolve('fixtures/server'),args:Array(101).fill('x'),tools:entry.tools},{...entry,tools:Array.from({length:101},(_,i)=>({name:'tool'+i,readOnly:true}))},{...entry,grant:true}])assert.equal(mcpCatalogSchema.safeParse([invalid]).success,false);
});
