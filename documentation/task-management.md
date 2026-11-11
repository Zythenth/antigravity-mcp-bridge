# Task management

## Waiting with progress

Use `black_gravity_wait` with `taskId`, `after` and `timeoutSeconds` (1–60, default 30). Clients sending `_meta.progressToken` receive `notifications/progress` with real event types and sequence numbers, including tool calls, test receipts and completion. The number is an event cursor. Notifications carry no total, percentage, file text, prompts or terminal output.

The response includes `ready`, `timedOut`, status, token usage and up to 1,000 events. Continue from `nextCursor`. `truncated` indicates that older events were lost. Wait timeouts and MCP call cancellation leave the task running. Use `black_gravity_cancel` to stop it. The final response is available without progress support. Wait can observe tasks from another bridge process through persisted state.

### Terminal wait command

The read-only `wait` command supports one task, one to 32 targets, or an entire group:

```powershell
black-gravity wait [--state-directory <absolute-path>] <taskId> [--after <n>] [--timeout <s>]
black-gravity wait [--state-directory <absolute-path>] <taskId>[:<after>] ... [--timeout <s>]
black-gravity wait [--state-directory <absolute-path>] --group <groupId> [<taskId>:<after> ...] [--timeout <s>]
```

For the plugin, use `node plugin/server.mjs wait ...`. The exact path of the active build is in `waitCommand.argv`. `black_gravity_health`, `black_gravity_run`, `black_gravity_resume`, `black_gravity_handoff`, `black_gravity_compare` (when it returns `taskIds`), `black_gravity_group_start` (with `--group <groupId>`) and `black_gravity_wait_many` (with `<taskId>:<nextCursor>` for targets without errors) return `waitCommand: { argv, sh, recommendedMode, reason }`.

- `background` with `verified-profile` applies only to clients and versions in `WAIT_MODE_PROFILES`. The verified client is Claude Code >= 2.1.310. Codex, Copilot CLI, VS Code, agy, Cursor, Gemini CLI and other clients are unverified for background, with no promise of completion notifications or additional profiles. Report any exception based on explicit host terminal capabilities as unverified.
- `foreground` applies to `unknown-client`, `version-below-minimum`, `invalid-client-version` and `missing-client-info`. Run a blocking terminal command. Use `black_gravity_wait` with `timeoutSeconds: 60` only when the host cannot run terminal commands.
- MCP client identity affects only `recommendedMode` and `reason`. Permissions, tool catalog and other results stay the same.

The state directory defaults to `BRIDGE_STATE_DIRECTORY` or `~/.black-gravity`. `--after <n>` accepts a safe integer >= 0 (default 0) only in single-task mode, with no colon and no group. Multi-target mode accepts two to 32 targets, or one with a colon. Each takes `<taskId>` with cursor 0 or `<taskId>:<after>`. Group mode accepts zero to 32 `<taskId>:<after>` seeds for tracked tasks. `--timeout <s>` defaults to 1,800 seconds and accepts up to 86,400. The polling interval is 500 ms.

In foreground, use a CLI timeout strictly below the terminal's actual deadline with a safety margin. For example, under a confirmed 600-second deadline use `--timeout 540`. In background, check the actual background deadline in the tool schema or local configuration. It can differ from foreground. In a Bash tool with a confirmed 600,000-ms background deadline, for example, pass `timeout: 600000` and `run_in_background: true`, and add `--timeout 540` to the returned command so it can emit its JSON line before termination. Keep the default 1,800 seconds when the host has no deadline.

The command uses `lstatSync` and `readFileSync` on `<stateDirectory>/<taskId>.json` and, for groups, `<stateDirectory>/group-<groupId>.json`. It follows existing `continuationTaskId` chains up to 64 hops. It creates no directories, files or locks. Stopping the command leaves tasks and groups running. Only questions and blockers published as structured messages, such as with `deliveryMode: "messages"`, can interrupt a wait. The command prints one JSON line without prompt, message or error text. Single-task example:

```json
{"taskId":"<uuid>","outcome":"completed","exitCode":0,"status":"completed","reason":null,"after":0,"cursor":1}
```

Multi-target and group results add `groupId`, `groupState` and `targets`, with `resumeAfter` for the next command:

```json
{"taskId":null,"groupId":null,"outcome":"completed","exitCode":0,"status":null,"groupState":null,"reason":null,"after":null,"cursor":null,"targets":[{"taskId":"<uuid>","status":"completed","after":0,"resumeAfter":0,"cursor":1}]}
```

Top-level `taskId`, `status`, `after` and `cursor` identify the target that caused the exit, or are `null` for collective completion, a paused or ended group, or a deadline. The precedence is a question or blocker, a failed, cancelled or timed-out target, a failed or cancelled group, completion, a paused group or stopped group owner, a stopped task owner, then the deadline. A recorded `continuationTaskId` appears in the result and corresponding target. For `failed`, `reason` gives `error.code` only when it matches `/^[A-Z][A-Z0-9_]{0,63}$/`. Other normal outcomes leave it `null` unless specified below.

For `question` or `blocker`, read the message with `black_gravity_wait` on the returned `taskId` and `after: cursor - 1`. After answering, restart with `--after <cursor>` for one task or `<taskId>:<resumeAfter>` pairs from `targets` for multiple tasks or a group. For `wait-deadline` (exit 8), keep the input cursor. Use the returned `--after <after>` or all `<taskId>:<resumeAfter>` pairs, avoiding automatic advancement to `cursor` or `messageCursor` that could skip unread messages. With a terminal available, restart the command without MCP polling.

| Code | Outcome | Condition and reason |
| --- | --- | --- |
| `0` | `completed` | One task completed, all targets completed, or the group and all its targets completed. `reason: null`. |
| `1` | `error` | Invalid arguments (`INVALID_ARGUMENTS`), relative or invalid state directory (`INVALID_STATE_DIRECTORY`), or three consecutive invalid file or JSON reads (`INVALID_STATE`). |
| `2` | `failed` | A target failed. `reason` is a valid `error.code` or `null`. |
| `3` | `cancelled` | A target was cancelled. `reason: null`. |
| `4` | `timeout` | A target reached its execution timeout. `reason: null`. |
| `5` | `question` | Public question with `sequence > after`. The target's `cursor` and `resumeAfter` take that sequence. |
| `6` | `blocker` | Public blocker with `sequence > after`. The target's `cursor` and `resumeAfter` take that sequence. |
| `7` | `unknown-task` | State directory or `<taskId>.json` missing (`TASK_NOT_FOUND`). |
| `8` | `wait-deadline` | `--timeout` reached with active targets or an unfinished group, including `created` (`WAIT_DEADLINE`). Restart with the input cursor or all returned `taskId:resumeAfter` pairs. |
| `9` | `owner-stopped` | The `ownerPid` for a still-active target is gone (`OWNER_STOPPED`). |
| `10` | `unknown-group` | State directory or `group-<groupId>.json` missing (`GROUP_NOT_FOUND`). |
| `11` | `group-paused` | The group is `paused` (`GROUP_PAUSED`) or `running` with its owner process gone (`OWNER_STOPPED`). |
| `12` | `group-ended` | Group `failed` or `cancelled` (its valid `error.code`, `GROUP_FAILED` or `GROUP_CANCELLED`). |

## Handoffs between roles

After a task completes, use `black_gravity_context` to inspect criteria, reports and `treeSha256`. Call `black_gravity_handoff` with `sourceTaskId`, the hash, `role`, `prompt` and optionally `model` and `decisions`.

The new task gets an independent copy of current files, including changes awaiting integration. It retains the original project baseline, criteria, up to eight planning or review reports and test provenance. Decisions are client reports. Reports and receipts retain their provenance and grant no integration authority. The whole context must fit the prompt limit. There is no silent truncation.

Planning, implementation and review can use separate roles, models and conversations. Treat handoff context as data to verify. The bridge checks hashes at admission and copying, including after queueing. Review checks that its copy stays intact, including ignored files. The implementation copy remains available for testing, verification and authorized integration. An implementation handoff from review preserves the accumulated patch against the original.

Copies still follow Git ignores and file and byte limits. A changed selection due to new ignore rules fails the handoff. Inspect the context again. Keep secrets out of decisions. `black_gravity_resume` retains the role and copy, and `black_gravity_handoff` creates a new role in another copy and session.

## Model comparisons

After `black_gravity_context`, call `black_gravity_compare` with `sourceTaskId`, `expectedContextSha256`, `prompt` and two to four distinct IDs from `agy models` in `models`. Each model reviews an independent copy of the same version in read-only mode. Comparison consumes quota per task and respects `MAX_CONCURRENT_TASKS`, queue, retention and copy limits. Copies are prepared before the group starts to avoid contention over the source copy.

Keep `comparisonId` and track each `taskId` with `black_gravity_wait`. `black_gravity_comparison` gathers reviews, errors, usage, missing models and findings by file, line and quote. `identical` means literally equal findings. `different` means different interpretations of the same span. `not-reported-by-all` means some reviewers did not report the span. No findings alone do not establish agreement or correctness.

`complete` requires all reviews to finish and their copies to still match the compared content. `contextStale` flags a changed, missing or unverifiable source or copy. Inspect `contextMatches` per review and `startErrors` for admission failures. Failed or removed tasks remain visible. Codex checks sources and synthesizes recommendations, differences and limits. The group performs no semantic vote and grants no integration authority. Each comparison task can be cancelled or discarded individually.

## Interactive replies and preflight token counts

`black_gravity_health.bridgeLimitations` exposes two unavailable capabilities:

- `interactiveReplies.available: false`. The [verified headless protocol](https://www.antigravity.google/docs/cli/headless/#unsupported-messages) rejects `control_request` and `control_response`. New text turns cannot answer pending permission requests. The bridge closes stdin after the prompt. Continue a completed conversation with `black_gravity_resume`. Inspect refused requests in events and errors and respect sandbox denials. The bridge's integration form is a separate MCP operation.
- `preflightTokenCount.available: false`, `exactTokens: null`. There is no verified `agy` command for counting tokens before submission. CLI counters are observed after execution. Character counts give neither exact tokens nor a quota budget. The bridge uses only the official CLI, with no additional API, credentials or estimate labeled as exact.

An open process or invented protocol messages do not resolve these limitations. Future support requires verifying the CLI version and contract.

## Delivery to the coordinator

Use `deliveryMode: "messages"` in `black_gravity_run` for structured public questions, blockers and a final-result excerpt. `black_gravity_wait` returns `messages` and message cursors, omitting detailed events and progress notifications. A question can end a wait before the task finishes. The coordinator can read full results and diffs when needed with the chunk readers.

Messages include provenance, reported model, ID, sequence and timestamp. Text is limited to 2,000 characters and up to 100 messages are retained per task. Pages indicate when older messages were lost. The final reference points to `black_gravity_read_result` with its hash. Model messages are reports and grant neither test evidence nor integration authority.

Omission retains `events` and its event history. `black_gravity_events` remains available for explicit detailed queries. `black_gravity_set_delivery_mode` changes task delivery. Start from `after: 0` after a change and send `cursorMode` from the previous cursor. On a mode change the wait resets to zero and reports `cursorReset: true`. Resumes inherit delivery mode without changing permissions or roles.

## Concurrent execution

The plugin configures two simultaneous tasks. The standalone server defaults to one. `MAX_CONCURRENT_TASKS` accepts 1 to 16. Resumes of the same copy remain sequential.

## Session messages

Use `black_gravity_send_message({taskId, messageId, text})` to send up to 2,000 characters with a client-selected UUID. Repeating the same ID and text returns the existing receipt. The same ID with different text is refused. Up to 20 inputs are retained per task.

An active turn leaves the receipt `queued`. After it finishes, the bridge resumes the official session in the same copy and processes inputs sequentially. `sent` reports that the bridge accepted the turn. Model consumption is unverified. Failures and cancellations are explicit. An interrupted send with no evidence of acceptance is not retried automatically.

Follow `continuationTaskId` with a fresh cursor at zero. `continuationPending: true` in `black_gravity_wait` means inputs still await dispatch after the previous turn. Resumes retain selection, skills, role, mode and criteria. Messages grant no permissions or integration authority, and agy control requests remain unavailable.

## Custom roles

Set `BRIDGE_CUSTOM_ROLES` to a JSON array in the server environment and restart the connection:

```powershell
$env:BRIDGE_CUSTOM_ROLES = '[{"name":"security-review","baseRole":"reviewer","description":"Access control review","instruction":"Inspect access controls in the requested scope and cite actual evidence."}]'
```

`black_gravity_roles` lists available names, descriptions, bases and instruction sizes. Select a name in `role` of `black_gravity_run` or `black_gravity_handoff`. MCP schemas advertise configured roles. A name allows up to 32 lowercase letters, digits and hyphens. Each role requires a `baseRole` and up to 8,000 characters of instructions. The optional description is capped at 500 characters. Up to 20 roles are accepted. Invalid entries, including built-in names, empty instructions, unknown bases or duplicates, are skipped without granting the role or blocking startup, and appear in `configurationIssues`.

`planner` and `reviewer` bases retain read-only mode, JSON contracts and citation checks. `implementer` retains copy-based writes and the same verification and approval requirements for integration. Custom instructions count toward the prompt limit and grant no additional permissions. The task saves its role definition and resumes with the original instructions and base even after configuration changes. Start a new task or handoff to switch roles.

## Events, sessions, and cancellation

Discovery checks for `stream-json` and `--sandbox`. The project validated `agy` 1.3.2. Structured events arrive as NDJSON and stderr diagnostics remain separate. Invalid lines are exposed as `stream.unparsed`. `EventStore` uses a bounded buffer and reports `truncated: true` when older events are lost. The bridge persists tasks, sessions, available events, model preferences and copy references atomically in `~/.black-gravity` or `BRIDGE_STATE_DIRECTORY`. Keep the state directory private and outside tracked projects and shared folders because it contains prompts and results.

With `BRIDGE_STATE_DIRECTORY` unset, startup and `--prepare-windows-runtime` perform a one-time migration when `~/.antigravity-mcp-bridge` exists, is nonempty and the new directory has no state. `wait` and `--windows-runtime-status` only read. An explicit state directory is used as given, including the previous path, without migration.

Migration copies files to `~/.black-gravity.migrating`, verifies each SHA-256 against the source, writes `migrated-from-legacy.json` last with the source path, date, file count, bytes, digest and skipped entries, then renames the directory to `~/.black-gravity`. Lock files (`*.lock`, `*.lock.recovery`), bridge `.tmp` leftovers and symlinks are skipped. Tasks, groups, project memory, approvals, policies, the model preference and runtime cache are copied byte for byte. File times and non-Windows permission bits are retained. New Windows files inherit the user profile ACL without copying explicit old ACL entries.

The previous directory stays in place for the previous build. Two operations still affect it. During migration, recovery settles pending Windows test executions and removes their leases. After migration, tasks carrying agent policy still read the old private policy storage, append to their receipts there on resume and delete those receipts on discard. Keep the previous directory until those tasks are discarded. Both state directories remain protected from sandbox policy paths. On rollback, the old build reads its own directory and newer work is not copied back. Copies created before the rename keep the `agy-mcp-copy-` and `agy-mcp-baseline-` names until discard.

The marker makes migration idempotent. After interruption, the next startup can discard an incomplete stage and start again, or publish a completed intact stage if the previous directory is idle and still matches it exactly. Creating and taking over staging is serialized by `~/.black-gravity.migrating.takeover`. A server that exits holding that gate can leave it behind and cause `legacy-state-busy`.

If the server refuses migration, it copies nothing and starts in degraded mode. Health reports `BRIDGE_STATE_DIRECTORY` in `configurationIssues` with:

- `legacy-state-busy` for a live or unverifiable old lock owner, a task owned by an active old server, a pending Windows lease, or a source file or directory that changes, appears, disappears or is replaced during the copy.
- `legacy-state-conflict` when both directories contain state and the new one was not migrated. A new directory holding only `windows-runtimes` is tolerated and its cache kept.
- `legacy-state-migration-failed` for another failure.

Stop the previous server or fix the cause and restart, or set `BRIDGE_STATE_DIRECTORY` explicitly.

**Recover a stale migration gate.** If health reports `legacy-state-busy` and stderr shows `Another server holds …\.black-gravity.migrating.takeover`, the gate was still present after a five-second wait. Another server can be staging or taking over a copy, or an exited server can have left the file behind. The bridge does not remove it automatically. Close every client that starts the server, including Claude Code and Codex. List the Node command lines, including servers launched through `npm start` (`node dist/src/index.js`), and confirm that all bridge processes have stopped:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
```

The gate contains only `{"pid":<number>}`. Confirm that `Get-Process -Id <number>` fails for that PID. Remove only the gate, keep `~/.antigravity-mcp-bridge` and `~/.black-gravity.migrating` intact, and restart the client:

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.black-gravity.migrating.takeover"
```

Startup discards incomplete staging or publishes a completed intact stage. An abandoned `~/.black-gravity.migrating.stale-<id>` is unused and can be removed after all servers have stopped.

Private state locks check file identity and a possession token before release. Recovery for a confirmed dead owner is serialized across processes. Incomplete locks, replaced files and interrupted recovery stay protected for local inspection with `STATE_BUSY`. Releasing an already released lock is idempotent. `StateStore` has no general cloud storage support. See [portable runtime](windows-runtime.md#portable-node-runtime) for the narrow OneDrive hardlink-count exceptions and the strict identity, hash, size, reparse, layout and single-link rules.

### Default model

Set `BRIDGE_DEFAULT_MODEL` to an ID returned by `agy models` for the initial default. `black_gravity_set_model` persists a preference shared by servers with the same private state. Precedence is task `model`, saved preference, environment setting and the agy default. Selection is checked against the current list before execution and unavailable IDs return `MODEL_NOT_AVAILABLE`.

Pass `model: null` for Auto. On a task it skips bridge defaults. In `black_gravity_set_model` it persists the agy default even when the environment variable is set. Omitting `model` uses the current preference. To restore the environment default, stop the server and remove only `model-selection.json` from private state.

`black_gravity_resume` accepts exactly one of `taskId` or the `sessionId` from `black_gravity_status` for a completed task, including after a restart, and reuses its isolated copy. Unknown, active, failed (except `TEST_FAILED`), integrated and other-project tasks are refused before starting a process, task or copy. Recover IDs with `black_gravity_tasks` and persisted sessions with `black_gravity_sessions`. Interrupted executions are never automatically repeated. They receive `SERVER_RESTARTED` when the previous process has ended. A live recorded PID blocks the copy with `ORPHAN_PROCESS_RUNNING`. The bridge does not kill recovered processes based only on PID. You can track another active server's tasks, but cancellation belongs to the starting server. Local locks prevent concurrent use of one copy. Cancellation stops the local subprocess, and partial copy changes can remain for review.

On cancellation and timeout, the first recorded intent wins (`TASK_CANCELLED` or `TASK_TIMEOUT`). The bridge stops the process and descendants where process-group membership and OS permissions allow it. Structured diagnostics distinguish `AGY_NOT_FOUND` (missing binary), `AGY_PERMISSION_DENIED` (binary access denied), `AGY_PROBE_FAILED` (discovery probe failed), `AGY_INCOMPATIBLE` (missing `stream-json` or `--sandbox`), `CLI_INPUT_FAILED` (stdin, EPIPE or early EOF), `AGY_IO_FAILED` (stream I/O) and `AGY_PROCESS_FAILED` (abnormal process exit). The bridge redacts known secret and error patterns, adds no credential values to logs and passes no tokens as arguments. External tool errors can still contain unknown secrets.

After every CLI run, including successful runs, the bridge observes its processes again and records `processCleanup`. On Windows, it reconstructs the tree using parent PID and creation time from spawn to exclude reused PIDs. It stops each process and confirms absence within three seconds. On POSIX, it stops its own process group and confirms absence. If confirmation fails, `processCleanup.verified` is `false`. Resume, tests, integration and messages for the copy are refused with `PROCESS_CLEANUP_UNVERIFIED` until later observation confirms termination. Windows descendants whose intermediate parent already ended cannot be associated by parent PID and are outside this check.
