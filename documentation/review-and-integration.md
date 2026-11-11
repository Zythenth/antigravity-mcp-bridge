# Review, integration, and testing

## Approval and integration modes

Set `BRIDGE_APPROVAL_MODE` in the server environment. The default when unset is `auto`. The only accepted values are `auto` and `ask`. Invalid values prevent startup.

- **Automatic (`auto`)**. `black_gravity_integrate` authorizes a verified patch at its current hash without an interactive MCP form. Validated `black_gravity_set_sandbox_policy` updates also apply automatically. The caller can propose narrow, verified grants needed for the authorized task. Delegated models have no authority to choose or authorize permissions. Integration still requires a completed write task, current preview SHA-256, approved acceptance criteria, file-grounded review, current observed tests without failures, source locking, compare-and-swap and path protection. Health reports `approvalMode: "auto"`, `integrationApproval.mode: "auto"` and `integrationApproval.method: "automatic"`.
- **Strict confirmation (`ask`)**. Integration and sandbox ceiling updates always require a human MCP form, even with roots configured in `BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS` or remembered in legacy `integration-approvals.json`. The previous “Don't ask again for this project” checkbox was removed. Health reports `approvalMode: "ask"`, `integrationApproval.mode: "ask"` and `integrationApproval.method: "mcp-form-elicitation"`.

Configure the mode persistently in the private server startup environment, such as the MCP client configuration or persistent user or system variables. A PowerShell assignment such as `$env:BRIDGE_APPROVAL_MODE = 'ask'` applies only to the current shell. Restart the MCP connection for changes to take effect.

Both modes keep Codex and `agy` permissions in force and have no fallback to host execution. Integration runs through MCP. Authorization leaves criteria, tests and technical review mandatory. Gemini text, caller messages and tool arguments grant no authorization or sandbox permissions. `black_gravity_health.integrationApproval.preauthorizedProjectCount` reports configured and legacy remembered roots. `ask` requires confirmation regardless of that count.

In `ask`, the form displays source, task, hash, affected files and line counts. Only `accept` with `confirm: true` allows application. Refusal, cancellation, timeout or unsupported forms preserve the original. The hash identifies the patch and confirmation arrives as a separate client response. There is no `approved` tool argument. The bridge checks the hash and source again after the reply. The form depends on a trusted client presenting the decision. Check `approvalMode`, `integrationApproval.available` and `integrationApproval.mode` with `black_gravity_health`.

## Implementation and review flow

For review, diagnosis or a second opinion, pass `mode: "read-only"`. The bridge requires `agy --mode plan`, checks afterward for any creation, modification or deletion, including newly ignored files, and refuses integration. This is a CLI restriction checked after the run, with no guarantee of physical write prevention. The default `mode: "write"` supports implementation in the copy. Resume retains the original mode.

1. Call `black_gravity_health` to check CLI, profile and approvals. Use `black_gravity_list_models` and `black_gravity_roles` to select advertised IDs and roles.
2. List eligible paths with `black_gravity_list_project_files`. When using `includePaths`, name the exact files in the prompt, ask the delegate to work only on them, mark missing dependencies unverified and finish without expanding to refused searches. Define `acceptanceCriteria` for all requirements before calling `black_gravity_run`. Keep the `taskId`.
3. Follow [the returned `waitCommand`](task-management.md#terminal-wait-command). Use foreground where a terminal is available, or verified background as recommended by the command. Check the host's actual deadline and keep the CLI timeout below it with margin, or retain the 1,800-second default if the host has no deadline. On `wait-deadline`, restart with the input cursor. Use `black_gravity_wait` with `timeoutSeconds: 60` only if the host has no terminal, continuing with `nextCursor` until `ready`. `timedOut` only ends the wait. Query detailed events with `black_gravity_events`.
4. On completion, check status and errors using `black_gravity_result` with `includeResult: false`. Read the result with `black_gravity_read_result` and the patch with `black_gravity_preview` (`includePatch: false`) and `black_gravity_read_patch`. Diagnose failures before resuming. `completed` only means the task ended.
5. On Windows LPAC, check the [sandbox policy](configuration-and-security.md#test-sandbox-policy) and run relevant tests with `black_gravity_test`, the preview hash and a selection within the approved policy. On other platforms or with `BRIDGE_TEST_EXECUTOR=agy`, omit `sandbox`, which the legacy path refuses. Track the returned test `taskId`. Inspect evidence provenance, exit codes and stale evidence, then refresh the preview. `black_gravity_record_test` records client reports and cannot substitute for observed executor evidence.
6. Check actual files against each criterion and send review evidence to `black_gravity_verify` with the current hash. Once verification passes and the observed tests are still valid, call `black_gravity_integrate` on the latest implementation task for that copy. The configured approval mode governs application. Changes to the patch, evidence or affected originals require rechecking.
7. Report observed usage with `black_gravity_usage`. Use `black_gravity_discard` when the copy can be removed.

This implementation flow needs `full` or `implementation`. Use read-only roles and their flows for planning, review and comparison. A review handoff gets a separate copy and leaves the latest implementation task unchanged.

## Verifying results

### Token usage

`black_gravity_status` and `black_gravity_result` include `task.tokenUsage`. `black_gravity_usage` aggregates retained tasks and accepts `taskId`, `sessionId` and `model` filters. It returns `byTask`, `bySession` and `byModel` with `inputTokens`, `outputTokens`, `totalTokens`, `thinkingTokens` and `cacheReadTokens`.

The [final agy result](https://www.antigravity.google/docs/cli/headless/#read-the-results) reports cumulative session usage. On resume the bridge saves previous counters and counts the delta for the next task, including across model changes. Totals of 120 and 170 represent 170 session tokens and 50 for the second task. `observedCumulative` preserves the last reported session total separately from retained-task usage.

Missing, invalid, reset or unbaselined counters are `null`. Check `available`, `partial`, `source` and `warnings`. The bridge uses neither estimates nor silent zeros. Failed tasks count when the CLI returns final counters. Before that, the task total can be unavailable. Retention removes older tasks from local aggregation. A `null` model means no ID was reported.

These figures come from the CLI and provide no billing calculation or global quota access. Cache and reasoning counters are separate dimensions. Do not add them to `totalTokens` again. The skill directs Codex to report available usage on completion or failure.

### Task roles

`black_gravity_run` accepts `implementer` (default), `planner`, `reviewer` and custom names advertised by `black_gravity_roles`. Planning and review require `mode: "read-only"` and `agy --mode plan`. Write requests for those roles are refused. Resumes keep the original role and definition.

Query roles require `agy --json-schema`. Planning returns `summary`, `steps` with files and observable checks, and `unverified`. Review returns `summary`, `reviewedFiles`, `findings` and `unverified`. Findings include P0–P3 severity, path, line, literal quote, message, impact and suggestion.

The full response includes the validated `task.report`. For compact delivery, read original CLI `structured_output` with `black_gravity_read_result`. Reports are `agy-reported`. A review's `citationsChecked: true` confirms paths and quotes. Interpretation and absence of defects still require judgment. Invalid formats, nonexistent files or invented citations prevent normal completion. A planning response records proposed steps and does not execute them.

### Reading large responses in chunks

Use `black_gravity_preview` with `includePatch: false` for files, statistics, hash and `patchLength` without the full diff. Call `black_gravity_read_patch` with `expectedSha256` and optionally a returned `path`. Git selects the file, including binary paths and names with spaces, without parsing patch headers. Any change to the full patch invalidates the read even when one file is selected.

Use `black_gravity_result` with `includeResult: false` to omit raw result, prompt, transferred reports, role instructions and the full copy file list. When `ready: true`, use `black_gravity_read_result` for serialized JSON. Save `contentSha256` and pass it as `expectedContentSha256` on subsequent pages.

Readers take `offset` (default 0) and `limit` (default 10,000, range 2 to 50,000), and return `text`, `nextOffset`, `hasMore`, `totalLength` and `contentSha256`. Concatenate `text` until `hasMore: false`, using each returned `nextOffset`. Offsets use UTF-16 units and preserve surrogate pairs such as emoji. Without omission flags the legacy options still return the full content.

Set `acceptanceCriteria` before a task. Each entry has `id`, `description` and optionally a `check` with `kind`, `path` and `text`. The kinds are `file-exists`, `file-absent`, `file-contains` and `file-not-contains`. The last two require `text`. Resumes retain criteria and execution prevents replacing them afterward.

After reviewing the patch, call `black_gravity_verify` with its current hash and `reviews`. For every criterion include `criterionId`, `verdict` (`passed`, `failed` or `unverified`), `path`, `line`, `quote` and `explanation`. The bridge checks the files, evaluates the conditions and verifies the exact line quotation. Model claims, `SUCCESS` and client-reported tests provide no substitute for that evidence.

Integration needs all criteria approved and review current. Missing or pending criteria cause `VERIFICATION_REQUIRED`. Changes to the patch or evidence files invalidate verification, including ignored files absent from the diff. The server checks again after human confirmation. Preview returns `verification` and `stale`.

Automated checks prove their declared conditions. Broader functional correctness depends on relevant tests and Codex review. The review stays `client-reported`: a correct quote alone gives no proof of the interpretation. This combines deterministic checks and review of final state, as described in the [agent evaluation guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Copies, review, and integration

Before starting `agy`, the bridge creates a temporary copy of eligible files and keeps a separate Git baseline. The copy is the CLI working directory and the CLI receives `--sandbox`. Only `black_gravity_integrate` changes the original after patch review. The bridge performs no commit, merge or push.

Secret preflight runs after Git ignores and `includePaths` selection and before copying. It blocks `.env`, `.env.local`, other `.env.*` variants, `.envrc`, private keys, keystores, known authentication files and high-confidence content patterns. The name check exempts `.env.example`, `.env.sample`, `.env.template` and `.env.dist`; their content is still inspected. Certificates, public keys and synthetic test fixtures remain allowed. The `copy.ready` event reports `blockedFiles` with only `path` and `reason` (`SECRET_FILE`, `SECRET_CONTENT`, `SECRET_EXCLUSION` or `UNSAFE_PATH`). Preflight cannot guarantee detection of arbitrary secrets in code, unknown formats or encrypted data.

When `agy` advertises `--add-dir` and `--new-project`, the bridge declares the copy as a workspace and creates a separate CLI project on the first run. Resumes preserve that project. These options do not prove all sandbox boundaries. Denied permissions still apply.

Results show `copyDirectory` and `includedFiles`. Copies stay for review for seven days after the last finished task. The server checks for expiry at startup and once per minute. Use `black_gravity_cleanup` for an earlier check. Cleanup failure leaves startup available, reports a code once on stderr and in health `maintenanceIssues`, and retries the next minute. `black_gravity_discard` removes a copy immediately through MCP. Resumed tasks share it and all lose access on discard. In-use copies are preserved. Evicting the last task record at the retention limit also removes the copy. `isolateWorktree: true` is accepted for compatibility and uses the same copy flow. `false` is refused.

`black_gravity_preview` returns `files`, `patch`, `sha256`, `summary` (A/M/D totals, lines and binary files), `fileSummaries` (insertions and removals per path) and `tests`. Binary line counts are `null`. New UTF-16-with-BOM files, such as Windows PowerShell 5.1 redirected output, enter the patch as binary and get an `encodingWarnings` entry. `black_gravity_record_test` receipts have `source: "client-reported"`. `black_gravity_test` receipts identify the executor that ran the command. Each receipt records the hash, date, exit code and output bounded by the test selection (4,000 characters by default). `stale: true` means the receipt no longer matches the current files. Failures remain visible for review.

The private baseline, patch and integration preserve bytes. Project attributes such as `* text=auto`, `eol=crlf`, `working-tree-encoding` and `ident` do not convert line endings, encodings or `$Id$` keywords. Before writing originals, integration applies the patch to copies of affected files in a private directory. It checks each against the original: LF and CRLF formats stay the same, mixed files keep the terminators on unchanged lines, and UTF-8 BOMs are preserved. Line-ending checks also cover UTF-16 with BOM, which must retain its byte order, and NUL-free text in other encodings such as Windows-1252, checked byte by byte. Other binary files are exempt. A removed UTF-8 BOM is restored when the remaining file is UTF-8 and reported as `restoredByteOrderMarks` in the result and `copy.integrated` event. Other line-ending or BOM changes fail with `LINE_ENDINGS_CHANGED` before writing.

Each file is then written atomically through a same-directory temporary file and rename, preserving original permissions. Deleted files are first moved to temporary names in the same directory. If a write fails, previously written files regain their old bytes, deleted files are restored and the operation fails with `INTEGRATION_FAILED`. After successful writes, the moved files are deleted. A file that cannot be deleted stays under its temporary name and is reported in `leftoverFiles`. A server crash during the writes is not recovered automatically.

The default copy limits are 10,000 files and 256 MiB (`MAX_COPY_FILES` and `MAX_COPY_BYTES`). Both are enforced during preliminary scanning and copying. Selection is measured before copy creation and actual copied bytes are measured again to detect source growth. A change in identity, size or hash fails with `SOURCE_CHANGED` or `CONTEXT_CHANGED`. A fork never silently skips a baseline file that has become a credential. Use `includePaths` to narrow the selection. More than 100 changed files cause `CHANGE_LIMIT_EXCEEDED` on completion, review or integration. The original stays intact. Narrow the task or configure the server limits explicitly.

### Running tests without Docker

Call `black_gravity_test` with `taskId`, `expectedSha256` and `command: { executable, args }`. It starts a continuation in the same copy and returns another `taskId`. Follow that ID through events and result, and review and integrate the latest task. `retries` defaults to 0 and accepts up to three explicitly requested repair attempts. `timeoutSeconds` defaults to 600.

After a Windows infrastructure failure, an explicit `black_gravity_test` can create a new attempt after native lease recovery. The failed receipt is retained. The retry requires the current preview and hash and is refused during active execution or incomplete recovery. CLI sessions cancelled, expired or failed due to model errors are ineligible.

Cleanup checks path and identity of owned temporary resources. A confirmed missing item does not invalidate other cleanup results. Replaced or linked items cannot be removed. Job, profile, alias and permission checks remain mandatory.

On Windows, the bridge starts each command directly in a dedicated AppContainer/LPAC process. The profile, SID and ACL grants are unique to the run and grants are removed at the end. New processes verify cleanup and recovery of interrupted runs. After power loss, ACLs remain until the next recovery. A cleanup failure invalidates test verification and blocks reuse of the grant.

The Windows executor needs the existing .NET Framework compiler for its controller. It installs no Docker and asks for no UAC elevation. Each run uses a new profile. Current validation covers process recovery and a new run. A physical reboot remains unverified.

The controller exposes the copy, prepared runtime and scratch directories through temporary two-level aliases, using a DOS name and a free letter from `D:` to `Z:` for each. It needs three free letters. It validates mapping identity and target before, during and after the command and removes mappings during cleanup or recovery. DOS names are scoped to the current logon. Letter reservations are coordinated per logon and letter. Mappings grant no volume-root access, persistent mount or UAC elevation.

Outside Windows, or when `BRIDGE_TEST_EXECUTOR=agy`, the legacy path uses `agy --sandbox` and `run_command` with a receipt tied to the exact call. There is no direct host fallback. Nonzero commands return `TEST_FAILED`. File changes during or after the command return `TEST_CHANGED_PATCH`. Integration needs current evidence.

Windows evidence uses `source: "windows-executor"` and `sandbox: "windows-lpac"`. Legacy evidence uses `source: "agy-tool"` and `sandbox: "agy-native-requested"`. Receipts include sandbox selection, policy hash, bounded output and before and after fingerprints. Known local execution uses zero model tokens. A requested model-assisted repair counts only CLI-reported usage, with missing counters as `null`. Use executor evidence, exit codes and sandbox fields for verification. Model output is not a receipt.

On Windows the bridge fills a missing `PATHEXT` with `.COM;.EXE;.BAT;.CMD` so PowerShell can find installed executables. Client-supplied values, including an empty one, are preserved. The SDK can omit inherited `PATHEXT` and make an installed Node appear missing. This fix covers discovery and all tasks without project configuration.

On Windows, use native `.exe` commands or `npm`/`npm.cmd`. The executor validates the installed npm launcher, package and `npm-cli.js`, then calls staged `node.exe` with literal arguments. Other interpreters and arbitrary `.cmd` or `.bat` files are unsupported. Staging rejects remote paths, devices, alternate streams and NUL. Only validated runtime files are copied under size limits. Runtime destinations, generic executables and ACL grants require one link. User-staged files cannot be links. Internal `cmd.exe` comes from a fixed Windows path.

For Node/npm tests and direct Git commands, the Windows executor stages Git for Windows discovered on `PATH`, if installed. Known `cmd` and `bin` launchers are resolved to the native binary in `ucrt64/bin` or `mingw64/bin`. Native and standalone installations are retained. A known layout without a valid binary or with unsafe links is refused. Only PE binaries, DLLs and public helpers enter the read-only isolated runtime. Destination files require a single link. Original installation files may contain hardlinks and receive no ACL grants.

The test `PATH` contains only staged runtime directories and exact `System32`. `GIT_EXEC_PATH` points inside the runtime alias. Global configuration points to a missing scratch file, with `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0`. Injected `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*` and `GIT_CONFIG_PARAMETERS` are stripped. Protected `safe.directory` entries are reset with `VALUE_0=''` and set only to the verified copy alias root (`VALUE_1`) and descendant repository roots with verified `.git` directories in the copy (`VALUE_2..N`) at startup. Wildcards and trust outside the copy are excluded. Repositories created later undergo normal Git checks. There is no inherited `.gitconfig`, credential or key access, and no Git download. Git is optional for Node/npm commands that do not need it. Commands that need Git fail when it is absent. Git files count toward copy limits. The executor gives no extra access to the Git installation, host execution or network.

With staged Git, new sandbox repositories default to `reftable` via `GIT_DEFAULT_REF_FORMAT=reftable` inside the isolated environment. The installed Git must support it. Existing repositories and host Git stay unchanged. The traditional `files` backend and Git builds without reftable have an LPAC limitation when checking private parent directories. The setting leaves those directories denied and grants no elevation or host fallback.

With staged Git, the controller checks access to the Windows Null device. If default LPAC access already permits reads and writes, it makes no ACL change or `WRITE_DAC` request. If access is missing and the current token permits `WRITE_DAC`, it records a temporary grant for that run's SID only. Cleanup checks that the Job is empty before removing grants. Inconclusive recovery retains the lease and blocks the run. Missing permission produces a diagnostic without elevation.

See [Node subprocess compatibility on Windows LPAC](windows-runtime.md#node-subprocess-compatibility-on-windows-lpac) for the pinned runtime, networking and real-account Windows test.

## Project tests

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build:plugin
npm.cmd run test:package
```

`npm test` uses a mock `agy` and consumes no quota. `npm run test:package` queries runtime status from the packaged build. Outside Windows, status should report `supported: false` without preparation. The suite starts the extracted package with `tests/mock-agy.mjs` and calls each MCP tool in two isolated states, empty and aged. A new tool without a case in `tests/tool-contract.mjs` fails the suite.

Optional real integration uses `npm run test:integration`. It creates a disposable repository, executes a task through MCP, confirms the original stays intact until integration and removes the repository. It simulates confirmation only for that disposable project. Real projects use the host's human approval interface when confirmation is configured. Run this test only when authenticated in `agy` and intending to use the real account.

The project uses the [MIT license](../LICENSE). See the [security policy](../SECURITY.md), [privacy policy](../PRIVACY.md), [changelog](../CHANGELOG.md) and [notices for distributed dependencies](../THIRD_PARTY_NOTICES.md). `npm run build:plugin` updates the bundle and regenerates notices from the dependencies it includes.
