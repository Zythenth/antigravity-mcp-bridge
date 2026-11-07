---
name: antigravity
description: Use when the user asks to delegate programming to Google Antigravity or agy, query its models, track a task, resume it or cancel it. Do not trigger for ordinary programming without a delegation request.
---

# Antigravity

Use the `antigravity_*` MCP tools; all communication with Google must go through the official `agy` CLI run by the bridge. The calling agent plans, tracks and reviews; Antigravity implements when the user asks for that delegation.

Open a reference only when the table at the end matches the task; search `references/` for any error, field or tool not covered here.

## Profile and approval modes

Check `antigravity_health`:
- **Tool profile**: `antigravity_health.toolProfile`. `query` and `review` run read-only; do not ask for missing tools or work around the profile. `full` and `implementation` offer the complete flow. To change it, set `BRIDGE_TOOL_PROFILE` in the server's private environment and restart the MCP connection.
- **Approval mode**: the skill MUST check `antigravity_health` and follow the mode reported in `health.approvalMode` (and `health.integrationApproval.mode`).
  - **`auto` mode (default if unset)**: skips interactive human confirmation forms for `antigravity_integrate` and for validated `antigravity_set_sandbox_policy` updates. **Do not impose guidance that requires extra manual authorization from the caller in `auto`**. Delegates via `agy` (Gemini) do NOT choose, do not authorize and do not grant permissions.
  - **`ask` mode (strict opt-in)**: ALWAYS requires human confirmation through an MCP form.
  - **Boundaries and limits**: no mode allows automatic fallback to the host or changes the permissions of the caller or of `agy`. Integration is performed exclusively through MCP; authorization NEVER replaces tests and code review. Do not loosen SHA-256 hashes, criteria, review, current observed tests, source-lock, CAS and path protection.

## Choosing the action

- For availability or authentication, call `antigravity_health`. If you receive `AGY_AUTH_REQUIRED`, tell the user to open `agy` interactively; do not try to read credentials or log in through the bridge.
- To learn the models, call `antigravity_list_models`. Use only IDs returned by the CLI. When the user says “Pro” or “Flash”, choose a compatible variant from the list and say which ID you chose. If the choice has a material impact and no preference can be inferred, ask. For “Auto”, pass `model: null`; do not invent an `auto` ID. Omitting the field uses the existing preference.
- When the user asks for cancellation, call `antigravity_cancel` with the `taskId` and confirm the status. Cancellation ends the local process; partial changes may remain.
- To continue a conversation, call `antigravity_resume` with the `taskId` of the previous task (after a restart, recover it with `antigravity_tasks`), never with a `sessionId` or a provisional value.

## Delegation and tracking

1. Identify the absolute Git root of the project. Before writing the task, read the relevant instructions and files and note existing Git changes. Do not include secrets or private documents in the prompt sent to Antigravity. Use `antigravity_list_project_files` to check what can go into the copy.
2. For a query, review, diagnosis or second opinion, use `mode: "read-only"`; this mode uses `agy --mode plan`, checks for changes at the end and does not allow integration. For implementation, use `mode: "write"` (default). Call `antigravity_run` with a concrete instruction and a verifiable criterion. Prefer `deliveryMode: "messages"` for ordinary delegations. Define `acceptanceCriteria` in `antigravity_run` before implementation, covering every explicit requirement.
   - The bridge requires `agy --sandbox` and always works in the copy. Select `includePaths` when only some files or folders are needed; the selection cannot include ignored files.
   - When specifying `includePaths`, the prompt written for the delegate MUST list the exact paths of those files and request changes or queries exclusively about them, instruct the delegate to report missing dependencies as unverifiable and to finish the task without widening the scope or attempting refused searches on disk. If you receive `COPY_LIMIT_EXCEEDED`, reduce the selection with `includePaths`. For `CHANGE_LIMIT_EXCEEDED`, review the size of the task with the user; do not try to work around the limit.
   - When available, check `antigravity_get_agent_policy` before delegating. When the task does not need a terminal, restrict `allowedTools` to the file tools and `finish`; say in the prompt what the coordinator will build and test on the host.
3. Keep the `taskId` and the `waitCommand` (`{ argv, sh, recommendedMode, reason }`) returned by `antigravity_run`, `antigravity_resume`, `antigravity_handoff`, `antigravity_compare`, `antigravity_group_start` or `antigravity_wait_many`. Follow `waitCommand.recommendedMode` strictly:
   - `"background"` (ONLY Claude Code >= 2.1.310 is verified): start `waitCommand.argv` (or `waitCommand.sh` in a POSIX shell) in the background right after delegating, and do not call `antigravity_wait`, `antigravity_status`, `antigravity_events` or their group and multi-task variants while it runs. Pass an explicit `timeout` in the Bash call (in milliseconds) and pass `--timeout` to the CLI `wait` command (in seconds) strictly below the host's real background deadline with a safety margin, so the command can emit its single JSON line before the host kills it. Check that deadline in the host tool schema or configuration; if the host imposes none, the product default of 1800s is preserved.
   - `"foreground"` (any other host; do not promise notifications): prefer running the same command in a blocking terminal instead of 60-second MCP polling, with `--timeout` strictly below the terminal's real deadline. Use `antigravity_wait` (`timeoutSeconds: 60`, continuing with `nextCursor` while `ready` is false) ONLY when the host cannot run terminal commands; a wait timeout or cancellation does not end the task.
   - Run the command as returned, adding only `--timeout`, `--after` or more targets. Never use a pipe or a redirection that replaces its exit code: `2>&1 | tail -3` reports the exit code of `tail`.
   - When it ends, read the JSON line and make ONE single query according to `outcome`: `completed`, `failed`, `cancelled` or `timeout` -> one `antigravity_result` with `includeResult: false`; `question` or `blocker` -> one `antigravity_wait` with `after: cursor - 1`, answer it and restart with `--after <cursor>`; `wait-deadline` -> restart with `--after <after>`, keeping the input cursor, without MCP polling; `owner-stopped` -> one `antigravity_status`; `unknown-task` or `error` -> check the IDs and directory and fall back to `antigravity_wait`. Stopping the command cancels no task.
4. After `completed`, call `antigravity_preview`, present `summary` and `fileSummaries`, review the whole patch and run the relevant tests in the copy.
   - Request `antigravity_preview` with `includePatch: false`. Read the diff of each changed file through `antigravity_read_patch`, with the full hash and the path given in the preview. Follow `nextOffset` until `hasMore: false`; do not declare the review complete if chunks remain.
   - When reviewing the patch, reject or fix duplicated blocks, lines rewritten without change, parameters dropped when wrapping functions, unrequested changes to timers, errors or lifecycle, values changed beyond those requested and unrequested new files, such as temporary or scratch files.
   - Record the commands actually run with `antigravity_record_test`, using the current hash and the output without secrets. These records are client reports, not independent verification by the bridge. Present failures and `stale: true` records; do not use them as valid evidence for the current patch.
5. Read the actual artifacts and compare each requirement with the result. For each criterion, send `antigravity_verify` a review with file, line, literal quote and explanation. Do not invent quotes, outputs or command runs. Classify lack of proof as `unverified` and defects as `failed`. `completed` and `SUCCESS` indicate that the run ended. Report a requirement as met only with pertinent evidence.
6. Call `antigravity_integrate` with the `taskId` and the `sha256` of the preview. Without criteria, a complete review or a current verification, the server blocks integration. If the patch or the evidence changes, review and verify again. Do not bypass the confirmation by applying the patch another way without the user's authorization. Report failures and limitations accurately.

## Rules for every delegation

- **Anti-AI Craft**: in new tasks, the bridge automatically prepares `anti-ai-code` and `anti-ai-security`; do not send them again in `skills` or ask the user to repeat the names. The implementer and the reviewer must each load, read and apply both skills in their own session, also in fixes, resumes and handoffs.
- `--sandbox` restricts the CLI's terminal commands, but does not guarantee complete file system isolation on Windows. Do not delegate access to sensitive files based only on this option; use the file list and review the content actually copied.
- After a failure or timeout, examine the events and the copy before repeating the task. Do not start a new run automatically if it could repeat effects or consume quota.
- When finishing, reporting a failure or ending a delegation, report the Gemini/agy tokens using `task.tokenUsage` or `antigravity_usage`. Show `totalTokens` and, when available, input, output, reasoning and cache. Identify the data as usage reported by the CLI.
- If there is `null`, `available: false`, `partial: true` or warnings, explain the limitation. Do not estimate missing counters.

## When to open a reference

| Open | When the task involves |
|---|---|
| [approval-modes.md](references/approval-modes.md) | Changing approval mode or tool profile, `approvalMode` missing, preauthorized roots |
| [specialist-tools.md](references/specialist-tools.md) | `mcpServers`, tools beyond the file tools above, `AGY_MCP_PERMISSION_REQUIRED`, pending agy permissions, token pre-counting |
| [models.md](references/models.md) | Current or default model, `antigravity_compare` |
| [copy-and-execution.md](references/copy-and-execution.md) | Copy contents and limits, line-ending errors, `leftoverFiles`, `TASK_OWNED_BY_OTHER_SERVER` |
| [waiting.md](references/waiting.md) | MCP waits, `truncated`, exit codes, multi-task or group waits, `continuationTaskId`, `deliveryMode: "events"` |
| [review-and-integration.md](references/review-and-integration.md) | Integration refusals, encoding issues, chunked result reads, `integrationApproval.available` false |
| [session-control.md](references/session-control.md) | `antigravity_send_message`, discard, cleanup, `SERVER_RESTARTED`, `ORPHAN_PROCESS_RUNNING` |
| [provided-skills.md](references/provided-skills.md) | `skills` option, `CRAFT_SNAPSHOT_*` errors |
| [token-usage.md](references/token-usage.md) | Usage across resumed or failed tasks |
| [roles.md](references/roles.md) | `role`, custom roles, `antigravity_handoff` |
| [windows-sandbox.md](references/windows-sandbox.md) | `antigravity_test`, sandbox policy, portable Node, LPAC failures |
| [private-memory.md](references/private-memory.md) | `antigravity_memory_*`, `memory` option |
| [groups.md](references/groups.md) | `antigravity_group_*`, `antigravity_wait_many`, peer messages |
| [workflows.md](references/workflows.md) | `definition.workflow`, `definition.budget` |
