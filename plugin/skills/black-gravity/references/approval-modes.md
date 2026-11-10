# Tool profile and approval modes

Reference for the [core skill](../SKILL.md). Open it when changing `BRIDGE_APPROVAL_MODE` or `BRIDGE_TOOL_PROFILE`, on a server without `approvalMode`, or with preauthorized roots.

## Available profile and approval modes

Check `black_gravity_health`:
- **Tool profile**: `black_gravity_health.toolProfile`. `query` and `review` run read-only; do not ask for missing tools or work around the profile. `full` and `implementation` offer the complete flow. To change it, set `BRIDGE_TOOL_PROFILE` in the server's private environment and restart the MCP connection.
- **Approval mode**: the skill MUST check `black_gravity_health` and follow the mode reported in `health.approvalMode` (and `health.integrationApproval.mode`).
  - **Server version identification**: if the `approvalMode` field is **missing** from the `black_gravity_health` response, this indicates that the MCP server is an **old (legacy) version** of the bridge. **NEVER confuse an unset environment variable with a legacy server version**: on modern servers, when `BRIDGE_APPROVAL_MODE` is not defined (unset), the server operates in the default mode `approvalMode: "auto"`.
  - **`auto` mode (default if unset)**: skips interactive human confirmation forms for `black_gravity_integrate` and for validated `black_gravity_set_sandbox_policy` updates. **Do not impose guidance that requires extra manual authorization from the caller in `auto`**; the caller may propose narrow, verified grants needed by the authorized task in tests. Delegates via `agy` (Gemini) do NOT choose, do not authorize and do not grant permissions.
  - **`ask` mode (strict opt-in)**: ALWAYS requires human confirmation through an MCP form (**MCP form elicitation**), even for previously configured roots or legacy remembered roots; the remember checkbox was removed from the form.
  - **Persistence and restart**: `BRIDGE_APPROVAL_MODE` settings must be recorded in the private startup environment of the MCP server (warning that PowerShell assignments such as `$env:BRIDGE_APPROVAL_MODE = ...` only affect the shell currently running); restart the MCP connection after any change.
  - **Boundaries and limits**: no mode allows automatic fallback to the host or changes the permissions of Codex or of `agy`. Integration is performed exclusively through MCP; authorization NEVER replaces tests and code review. Do not loosen SHA-256 hashes, criteria, review, current observed tests, source-lock, CAS and path protection.

## Approval and integration modes

The MCP server operates according to `health.approvalMode` (controlled by `BRIDGE_APPROVAL_MODE`, default `auto` when not configured/unset; it strictly accepts `auto` or `ask`):

- **Automatic mode (`auto`, default)**: `black_gravity_integrate` authorizes and applies verified patches automatically, skipping interactive MCP human confirmation forms. Do not impose additional manual confirmations on the caller in `auto`. The caller may propose narrow, verified grants needed by the authorized task in tests. Agents delegated via `agy` (Gemini) do NOT choose, authorize or grant permissions. Security controls are not loosened: SHA-256 hashes, criteria in `black_gravity_verify`, review grounded in the actual files, current observed tests without failures, source-lock, CAS and strict path protection (path-protection) remain strictly mandatory.
- **Strict confirmation mode (`ask`)**: strict opt-in that ALWAYS requires interactive human confirmation through an MCP form (**MCP form elicitation**) for every patch integration (`black_gravity_integrate`) and for sandbox policy updates (`black_gravity_set_sandbox_policy`). There is no bypass for roots previously configured in the environment (`BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS`) or legacy remembered roots (`integration-approvals.json`); confirmation is always mandatory. The remember checkbox ("Do not ask again in this project") was removed from the form.

To configure the mode persistently, define `BRIDGE_APPROVAL_MODE` in the private startup environment of the MCP server (remembering that PowerShell assignments only affect the current shell session) and restart the MCP connection. No mode performs automatic fallback to the host or changes the permissions of Codex or of `agy`. Integration is performed exclusively through MCP; authorization never replaces criteria, tests and technical review.
