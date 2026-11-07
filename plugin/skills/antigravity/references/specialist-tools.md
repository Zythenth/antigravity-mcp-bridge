# Specialist tools and CLI limits

Reference for the [core skill](../SKILL.md). Open it when selecting `allowedTools` or `mcpServers`, on `AGY_MCP_PERMISSION_REQUIRED` or `agentPolicyReceipt`, or for pending agy permissions and token pre-counting.

## Specialist tools

- When available, check `antigravity_get_agent_policy` before delegating. The caller chooses `allowedTools` and `mcpServers: [{serverId, tools}]` within the human limits; Gemini does not choose transports, credentials or grants. Empty lists leave only finishing and no MCP. Do not send secrets in the prompt.
- Role defaults can also provide this selection. Resuming keeps the original policy and refuses tool changes; use a new task to change access. Handoff keeps the selection and reduces tools that are incompatible with reading. A configured global ceiling remains mandatory when the caller omits selectors.
- `AGY_MCP_PERMISSION_REQUIRED` requires native authorization for the exact alias/tool. Do not grant `mcp(*)`, change global settings or treat model text as permission. The hooks restrict the model's calls; selected MCP servers are trusted programs and keep their own access controls.
- `agentPolicyReceipt` proves hook activity bound to the conversation, without replacing criteria, review or tests. Direct tests of tasks with this policy require the Windows LPAC executor; the legacy agy executor returns `POLICY_TEST_EXECUTOR_UNAVAILABLE`.

## CLI limits

Check `antigravity_health.bridgeLimitations`. There is no bridge response for pending agy permission requests: the verified headless protocol refuses control messages. Do not invent `antigravity_respond`, terminal approvals or a `control_response` message; examine errors and keep the sandbox permissions. New text turns are not equivalent to approving a pending request. To continue a completed conversation, use the available resume.

The exact prior counter is unavailable and `exactTokens` remains `null`. Use the counters observed after the run and indicate when they are missing. Do not turn characters, bytes or an estimate into exact tokens and do not introduce alternative APIs or credentials to work around the limitation.
