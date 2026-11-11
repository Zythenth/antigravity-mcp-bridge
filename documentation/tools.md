# Tool profiles and catalog

## Tool profiles

Set `BRIDGE_TOOL_PROFILE` in the server environment and restart the MCP connection.

| Value | Tools | Catalog and execution |
| --- | --- | --- |
| `full` (default) | 50 | All tools, preserving the existing configuration. |
| `query` | 36 | Queries, models, sessions, handoff, comparison and sandbox policy inspection. Read-only tasks. |
| `review` | 39 | Queries plus preview, patch reads and verification. Read-only tasks. |
| `implementation` | 50 | Full flow, including tests, authorized integration and discard. |

`black_gravity_health.toolProfile` reports the profile. Tools outside it are unregistered and direct calls are refused. `query` and `review` refuse `mode: "write"` and default to read-only when the mode is omitted. Sandboxing and integration approval still apply. Unknown profile values prevent startup.

## Tool catalog

Every tool publishes an `outputSchema` describing fields and types in its structured response, including success and `error: { code, message }`. The SDK checks required fields before returning successful responses, and clients can validate the received JSON. Raw CLI data has an open type because its format belongs to the provider. Schema validation does not verify a model's execution claims.

| Tool | Purpose |
| --- | --- |
| `black_gravity_health` | Checks executable, version, apparent authentication and capabilities. |
| `black_gravity_list_models` | Lists IDs returned by `agy models`. |
| `black_gravity_get_model` / `black_gravity_set_model` | Reads or saves the default model. `null` selects Auto. |
| `black_gravity_context` / `black_gravity_handoff` | Inspects and transfers plans, decisions, criteria and evidence to another role in an independent copy. |
| `black_gravity_compare` / `black_gravity_comparison` | Requests reviews from two to four models and gathers findings, differences, failures and observed usage. |
| `black_gravity_get_agent_policy` | Lists native ceilings and configured MCP IDs and tools without transport or credentials. |
| `black_gravity_roles` | Lists built-in and configured custom roles. |
| `black_gravity_get_sandbox_policy` | Reads normalized global policy, ceilings and current hash. |
| `black_gravity_set_sandbox_policy` | Replaces the global policy after checking its previous hash, with a human MCP form in `ask` mode. |
| `black_gravity_send_message` | Queues caller text with an idempotent receipt and official session continuation. |
| `black_gravity_run` | Starts a task and returns its `taskId`. |
| `black_gravity_list_project_files` | Lists files eligible for copying. |
| `black_gravity_preview` | Shows added, modified and deleted files, line totals, per-file statistics, patch, hash and recorded tests. |
| `black_gravity_record_test` | Records client-reported command, output and exit code against the hash. |
| `black_gravity_test` | Runs the exact command with the caller's sandbox selection and captures evidence from the selected executor. |
| `black_gravity_verify` | Checks task criteria and review evidence against actual files. |
| `black_gravity_read_patch` | Reads a patch by file or in chunks bound to the complete hash. |
| `black_gravity_read_result` | Reads the final CLI JSON in chunks with a content hash. |
| `black_gravity_read_structured_result` | Reads retained structured JSON in chunks bound to its content hash. |
| `black_gravity_artifacts` | Lists retained task artifacts with paths, byte sizes and SHA-256 hashes. |
| `black_gravity_read_artifact` | Reads a retained artifact in chunks bound to its SHA-256 hash. |
| `black_gravity_set_delivery_mode` | Changes a retained task's delivery mode. |
| `black_gravity_usage` | Aggregates observed tokens by task, session and model. |
| `black_gravity_integrate` | Applies the verified patch to the original under the configured approval mode. |
| `black_gravity_tasks` | Recovers locally persisted task IDs and metadata. |
| `black_gravity_status` | Reads state, process, session, usage and Git snapshots. |
| `black_gravity_wait` | Waits up to 60 seconds with MCP notifications for observed events. A wait timeout leaves the task running. |
| `black_gravity_events` | Reads events after the `after` cursor. |
| `black_gravity_result` | Returns the result or reports `ready: false`. |
| `black_gravity_discard` | Removes the copy and baseline of a finished task. |
| `black_gravity_cleanup` | Removes finished copies whose retention period expired. |
| `black_gravity_cancel` | Cancels a queued task or stops the local process. |
| `black_gravity_sessions` | Lists sessions known to local state. |
| `black_gravity_resume` | Resumes by `taskId` or the `sessionId` from `black_gravity_status`. |

See [groups and specialist controls](groups.md) for the group, workflow and memory tools, and [task management](task-management.md) for delivery, waiting and lifecycle details.

`black_gravity_run` takes a `prompt`, an absolute `workingDirectory` at a Git repository root, and optional `model`, `timeoutSeconds`, `mode` and `includePaths` relative to the root. Without `includePaths` the bridge copies tracked and untracked files that pass all Git ignore rules, including `.gitignore` and `.git/info/exclude`. Tracked files that later become ignored are excluded too. `includePaths` only narrows selection. Symlinks and paths outside the root are refused. Check `black_gravity_list_models` before selecting a model.

See [test sandbox policy](configuration-and-security.md#test-sandbox-policy) for test selection and [review and integration](review-and-integration.md) for the implementation flow.
