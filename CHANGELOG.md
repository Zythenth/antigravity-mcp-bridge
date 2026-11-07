# Changelog

## Unreleased

- The `antigravity` skill (core, the 14 references, and `agents/openai.yaml`) and the confirmation forms the server shows for sandbox policy updates and integration are now in English. Each rule keeps its scope, conditions, exceptions, and numbers; tool names, parameters, schemas, error codes, validation, and behavior do not change, and `tools/list` stays identical. The core remains within the 12,000-byte limit (11,715 bytes with CRLF line endings).

- `npm test` and the CI shards now run with their own temporary directory, removed at the end, and no longer accumulate `agy-*` folders in the system temporary directory. The folder of an interrupted run is removed by a later run, after the owning process ends and the folder has gone one hour without changes.

- Line-ending restoration no longer fails when a file unrelated to the task, such as another program's temporary file, disappears from the copy between listing and reading. Other read errors still abort the operation.

- The bridge's Git operations spawn fewer processes: `rev-parse`, `ls-tree`, and `cat-file`, which only read objects and references, no longer look up `core.excludesfile` before running. The lookup remains in every command that applies ignore rules.

- The transition of interrupted tasks during startup recovery (`SERVER_RESTARTED`) no longer writes one snapshot at a time during `refresh()`. Snapshots are computed first and published as a batch: before any write, each destination is opened for writing, so a read-only snapshot, whether by attribute or by a deny-write ACL on Windows, keeps all files intact and, at startup, leads to degraded mode without logging `task.failed` to `stderr`. Because renaming several files is not atomic, a failure during publication itself can still leave some of the tasks written; updates to other tasks (such as `caller.messages-stopped`) are published before the tasks that transition, and the next startup, with the directory fixed, reaches the same state as a startup without failure, with no duplicate events. Snapshots that do not change still require no write.

- The read-only `wait` subcommand now supports waiting on several tasks together (1 to 32 `<taskId>[:<after>]` targets) and waiting on entire groups (`--group <groupId>` with 0 to 32 `<taskId>:<after>` seeds, following `continuationTaskId` chains up to 64 hops and newly admitted nodes), keeping the single-task mode (`<taskId> [--after <n>]`) identical. In the multi and group modes, the JSON line includes `groupId`, `groupState`, and `targets` (with `resumeAfter` ready to restart as `<taskId>:<resumeAfter>`) and adds exit codes `10` (`unknown-group`), `11` (`group-paused`), and `12` (`group-ended`). The `waitCommand` metadata now includes `recommendedMode` (`"background"` or `"foreground"`) and `reason` (`verified-profile`, `unknown-client`, `version-below-minimum`, `invalid-client-version`, `missing-client-info`) from the versioned `WAIT_MODE_PROFILES` table (`claude-code >= 2.1.310` verified for `"background"`, other clients on `"foreground"`), without changing permissions, the tool list, or any other field, and is now also returned by `antigravity_compare`, `antigravity_group_start`, and `antigravity_wait_many`.

- The Anti-AI Craft snapshot moves to pinned revision `201fec5`. The `anti-ai-code` skill gains rules for tests that depend on the execution environment (canonical paths, explicit environment in child processes, transient `EPERM`/`EBUSY` on Windows, line endings, and deadlines on the slowest runner) and a defect-class section: decide whether the failure reaches the product before fixing only the test, look for other occurrences, and prefer prevention. The manifest and `THIRD_PARTY_NOTICES.md` follow the revision.

- `antigravity_test` with the `agy` executor (default on Linux and macOS; on Windows, with `BRIDGE_TEST_EXECUTOR=agy`) works again in the distributed package. Bundling with esbuild replaced `require` with `__require` inside the serialized function that runs the command in the copy; the test process failed with `ReferenceError: __require is not defined` before emitting the receipt, and the task always ended with `TEST_EXECUTION_UNVERIFIED`. The function now receives the module loader as a parameter.

- `npm run test:package` now calls the 50 MCP tools of the extracted package, with the fake agy, in two isolated states (empty and aged). A table with one case per tool is compared with `tools/list` in both directions; each response is validated against the published `outputSchema` or against the expected error envelope; the server must answer `ping` after each call; and the duration of each state is recorded. A tool without a case or a case without a tool fails the test.

- A failure of the automatic copy cleanup at startup or in the timer no longer brings the server down; a single warning on stderr with only the code, without paths; `antigravity_health.maintenanceIssues` with `{ operation: 'copy-cleanup', code, since, failures }`; the cleanup is retried every minute and the item disappears on the first success; no copy is discarded because of the failure.

- Cleanup of expired copies (`COPY_RETENTION_HOURS`) no longer brings the MCP server down at startup. Previously, when there was one expired copy and another copy after it, discarding the first reloaded the state and the next pass threw `TypeError: Cannot read properties of undefined (reading 'record')`; at startup the process exited before `initialize` and the client showed only "Connection closed", and in the timer the cleanup stopped midway. Now all expired and inactive copies are discarded in the same cleanup, and active copies or those still within retention remain preserved.

- `BRIDGE_STATE_DIRECTORY` now starts in degraded mode when configured with an invalid path (relative, on Windows a relative root or drive such as `\state` or `C:state`, containing a NUL byte or characters reserved on Windows, or being a symbolic link/junction), instead of bringing the MCP server down before `initialize`:
  - The server starts normally, answers `initialize` and `tools/list`, and emits a single warning on `stderr`;
  - `antigravity_health` reports the problem in `configurationIssues` as `{ variable: 'BRIDGE_STATE_DIRECTORY', reason }` (reasons: `not-absolute`, `invalid-entry`, `link`, `not-directory`, or `unusable`) without exposing the configured value or touching the state directory, and omits `waitCommand` in degraded mode;
  - All tools that read or write state refuse calls with `INVALID_STATE_DIRECTORY` through a central barrier in the server and in `TaskManager`, while tools proven to be stateless (`antigravity_list_models`, `antigravity_roles`) and Windows runtime queries (`windowsRuntimeStatus`) remain operational;
  - There is never a fallback to the default directory (`~/.antigravity-mcp-bridge`) nor resolution against the current working directory (`process.cwd()`), preventing the creation of files outside the destination; the `wait` command reuses the same shared validator, also rejecting root-relative paths or paths with characters reserved on Windows;
  - `cleanup()` and `shutdown()` become harmless no-op operations in degraded mode.

- Variables for trusted resource paths (`BRIDGE_ANTI_AI_CRAFT_DIRECTORY`, `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY`, and `AGY_PATH`) now adopt the startup fault-tolerance mechanism: they do not bring the MCP process down in `loadConfig`, emit a single warning on `stderr`, report the problems in `configurationIssues` in `antigravity_health`, and explicitly refuse the affected operations with `INVALID_CONFIGURATION`, without ever resolving relative paths against the current directory (`process.cwd()`), using default paths in place of invalid values, or exposing the configured values:
  - `BRIDGE_ANTI_AI_CRAFT_DIRECTORY`: relative paths or paths containing a NUL byte do not use the current directory nor silently fall back to the embedded snapshot; while it is invalid, any run that would attach the Anti-AI Craft skills (`prepareCraft`) is refused with `INVALID_CONFIGURATION` before copying files or invoking the CLI. With `BRIDGE_ANTI_AI_CRAFT=off`, runs proceed normally without using craft.
  - `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY`: invalid paths (relative, containing a NUL byte, UNC, device paths, extra colons, `.` or `..` segments, or a volume root) no longer throw at startup and do not fall back to the default directory; the portable runtime becomes unavailable, reporting an `INVALID_CONFIGURATION` error in status queries (`antigravity_health` and `--windows-runtime-status`), in preparation (`--prepare-windows-runtime`), and in any run configured with `BRIDGE_WINDOWS_NODE_RUNTIME=portable`, while `system` mode remains fully functional.
  - `AGY_PATH`: relative paths with a separator (such as `bin/agy` or `.\agy` on Windows), values with a drive prefix without a complete root on Windows (such as `C:agy.exe`), or values containing a NUL byte are not resolved against the cwd nor fall back to the system `agy` through `PATH`; the CLI becomes unavailable, reporting `installed: false` and a neutral empty path in `antigravity_health`, and any attempt to run tasks or list models is refused with `INVALID_CONFIGURATION`; simple names without separators and without a drive prefix (such as `agy` and `agy.exe`) and absolute paths (including extended-length ones on Windows) remain fully supported.

- Invalid restrictive settings in `BRIDGE_ALLOWED_AGY_TOOLS`, `BRIDGE_SECRET_EXCLUSIONS`, and `FORBIDDEN_DIRECTORIES` no longer bring the MCP server down in `loadConfig`; they now fall back to the most restrictive mode or refuse the affected operations with `INVALID_CONFIGURATION`, without ever widening permissions or leaking the configured values in diagnostics:
  - `BRIDGE_ALLOWED_AGY_TOOLS`: an unreadable value (invalid JSON, a value that is not a list, or a list with more than 5 items) makes the native tool ceiling fall back to an empty list (`allowedAgyTools: []`, allowing only the implicit finish); unknown or non-string tools are ignored individually; repeated tools are kept only once with a duplicate record; and policy enforcement remains active whenever the variable is defined.
  - `BRIDGE_SECRET_EXCLUSIONS`: any problem (malformed JSON, non-list, non-string or empty item, NUL byte, absolute path, or traversal with `..`) records the problem in `configurationIssues` and invalidates the entire exclusion list, so that tasks, baseline inspection, preflight, and copy creation refuse with `INVALID_CONFIGURATION` before any copy, without silently omitting deny patterns.
  - `FORBIDDEN_DIRECTORIES`: relative paths or paths containing a NUL byte are never resolved against the current working directory (`process.cwd()`); they are recorded as problems in `configurationIssues` and mark the list as unusable; while it is invalid, task, group, file listing, and sandbox policy update operations refuse with `INVALID_CONFIGURATION`, keeping the valid absolute directories protected.

- Invalid settings and grants in `BRIDGE_ALLOWED_ENV_VARS`, `BRIDGE_SECRET_EXCEPTIONS`, `BRIDGE_MCP_CATALOG`, `BRIDGE_CUSTOM_ROLES`, and the `integration-approvals.json` state file are now ignored without bringing down the MCP server or `antigravity_health`. Invalid entries or files are ignored without granting anything, keeping the valid entries; the server starts normally, emits a single warning on `stderr`, and reports the problems in `configurationIssues` in `antigravity_health`. Writing remembered roots to `integration-approvals.json` remains strict and refuses to overwrite invalid files.

- `BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS` now ignores invalid entries without granting preauthorization or bringing down the MCP server process. Previously, if the variable contained malformed JSON or a nonexistent/renamed folder, the server exited with an error before `initialize` and the client showed only "Connection closed". Now the server starts normally, ignores the invalid entry without granting any preauthorization, emits a single warning on `stderr`, and exposes the problems in `configurationIssues` in `antigravity_health` (with the variable, an optional position, and the reason, without exposing paths or values).

- Read-only terminal command `wait [--state-directory <dir>] <taskId> [--after <n>] [--timeout <s>]` and `waitCommand` metadata (`{ argv, sh }`) in `antigravity_health`, `antigravity_run`, `antigravity_resume`, and `antigravity_handoff`, allowing a background wait until the task reaches a terminal state or publishes a question/blocker with `sequence > after`. The command only reads `<dir>/<taskId>.json` every 500 ms (default deadline of 1800 s and maximum of 86400 s), does not create directories, write files, or acquire locks, and stopping it does not cancel the task; on exit, it prints a single JSON line (`{ taskId, outcome, exitCode, status, reason, after, cursor[, continuationTaskId] }`) without exposing prompts, message bodies, or error texts and returns dedicated exit codes (`completed` 0, `error` 1, `failed` 2, `cancelled` 3, `timeout` 4, `question` 5, `blocker` 6, `unknown-task` 7, `wait-deadline` 8, `owner-stopped` 9).

- Tools that end with an error in the agy stream now produce `tool.failed` with an error summary in `failure`, instead of remaining as `tool.started`; snapshots no longer write each agy frame twice, persisting `rawIsData` or `rawEnvelope` and rebuilding `raw` on read (old snapshots load unchanged; an earlier bridge version reading a new snapshot sees the events without `raw`); an edit search that fails under the tool policy records in `editSearch` the hash, the byte size, and the line count of the searched text and the class of the difference (`line-endings`, `whitespace`, `unicode`, `unknown`), never the text itself; without a tool policy, the class is `unknown`.

- agy write runs, including Windows test repair, are now refused before the CLI starts, with `UNSUPPORTED_TEXT_ENCODING` and the list of files, when the copy has a file that is not UTF-8 and that Git would put in the patch as text, according to the `diff` attribute and the file's NUL bytes. Previously, the whole run executed and only the preview failed, with `UNSUPPORTED_PATCH_ENCODING`, as soon as one of those files was edited. The message suggests marking the file as `binary` in `.gitattributes`, leaving it out with `includePaths`, or converting it to UTF-8; read-only runs are not affected. A new UTF-16 file with a BOM, such as redirected output in Windows PowerShell 5.1, still enters the patch as binary, now with a warning in `encodingWarnings` in the preview and in the integration result. The copy's private repository now also ignores the project's `working-tree-encoding` and `ident`; previously, a UTF-16LE original marked with `working-tree-encoding=UTF-16` came back from Git in UTF-16BE and a `$Id$` was expanded on an unedited line. Integration now also checks the line endings of originals that are not UTF-8 (UTF-16 with a BOM and text without NUL bytes, such as Windows-1252) and refuses the change with `LINE_ENDINGS_CHANGED`, without writing to the original.

- Integration no longer changes line endings and the BOM of the original project. The private baseline, the patch, and the application now treat files as bytes (`* -text` in the private repository's attributes, which takes precedence over `.gitattributes`); previously, with `* text=auto`, an LF file in the original became CRLF on Windows and a mixed file was rewritten in the majority format. The patch is now first applied to copies of the affected files in a private directory and each result is checked against the original: LF and CRLF files stay in the same format, mixed files keep the ending of each unedited line, and the UTF-8 BOM is preserved. A BOM removed by the patch is automatically restored as long as the rest of the file is UTF-8 and listed in `restoredByteOrderMarks` in the `antigravity_integrate` result and in the `copy.integrated` event; any other change refuses the integration with `LINE_ENDINGS_CHANGED`, without writing anything to the original. Only then is each file written atomically, keeping the original's permissions (only a mode change present in the patch alters the executable bit); a deleted file is first moved to a temporary name in the same folder. If a write fails midway, the files already written return to their previous bytes, the deleted ones return to their place, and the operation fails with `INTEGRATION_FAILED`. With everything written, the deleted files are removed; one that cannot be removed is listed in `leftoverFiles`. Additions in directories that do not exist yet are now written at the full path. A crash of the server process during the writes is still not recovered. In the copy, files that were already mixed are no longer normalized to the majority format after the run, and a BOM that the executor removed comes back, with the `patch.bom-restored` event.

- agy write runs, including Windows test repair, now receive pure CRLF text files in LF: the CLI's edit tool requires an exact match and failed on CRLF with "target content not found", repeating calls until the timeout. LF, mixed, lone-CR, binary, or over-16 MiB files stay intact, as does the copy in native test runs by agy itself, because tests need to see the original bytes and the fixes between attempts happen in the same session. The list of converted files is recorded alongside the copy before the first conversion. As soon as the run's processes have provably ended, and before the preview, tests, review copies, and integration, all converted files return to CRLF, not just the edited ones; unedited files remain byte-identical to the original, even with `* text=auto` or `eol=crlf`, and converted content that the CLI only renamed or copied to a new path also returns to the original bytes. The line-ending reference for edited files is now the file itself before the run, and not the normalized index blob, which with `* text=auto` was in LF. While there are converted files without restoration, the copy refuses to be read with `LINE_ENDINGS_UNRESTORED`. The `copy.line-endings-converted` and `copy.line-endings-restored` events record the counts.

## 0.9.0

- State saved by earlier versions is now sanitized only once per file version and kept in a sanitized copy in `sanitized/`, inside the state directory; later loads and queries reuse that copy, and the original file is not rewritten. Previously, each startup and each status query redid the sanitization of all old snapshots, which could delay server startup by minutes. An invalid copy is discarded and rebuilt, and a change in the original file invalidates the previous copy.

- Canceling a Windows test right after queuing it now prevents its execution. Previously, a task already dispatched but still marked as queued was reported as canceled while the execution continued, started the process, and ended later; now the cancellation uses the termination signal and the execution stops before starting.

- Rules attached to every prompt against searches outside the copy, repeating denied tools, duplication, rewritten lines, line endings, signatures, timers, values changed beyond the request, and temporary files; before the preview, edited files return to the line-ending format of the original kept in the copy's baseline, even when the edit converted the entire file, and new or already mixed files follow the majority format, with the `patch.line-endings-normalized` event.

- New tasks automatically receive `anti-ai-code` and `anti-ai-security` as permanent skills and a catalog of up to 8 KiB of the other Anti-AI Craft skills, read on demand and read-only from a private copy verified per revision, added to the CLI with `--add-dir`. Resumes and handoffs keep the original snapshot; name conflicts fail with `SKILL_CONFLICT`; a missing or tampered snapshot fails with `CRAFT_SNAPSHOT_MISSING` or `CRAFT_SNAPSHOT_INVALID`. `BRIDGE_ANTI_AI_CRAFT=off` disables the policy and `BRIDGE_ANTI_AI_CRAFT_DIRECTORY` sets another verified snapshot. Under a tool policy, hooks allow only reading in that root.

- The native inspection of reparse points in the portable runtime cache on Windows now gives the inspector compilation its own 60 s limit; the inspector execution keeps the 15 s limit. On slow machines, runtime preparation no longer fails just because the .NET compiler took long to start; an expired deadline still refuses the cache with `UNSAFE_PORTABLE_NODE_CACHE`.

- The package now distributes the Anti-AI Craft 0.6.0 snapshot (pinned revision `8f6d539`, six skills, references, and a visual library) in `plugin/anti-ai-craft/`, with a hash manifest verified in the build, the tests, and the tarball. The `scripts/update-anti-ai-craft.mjs` script fetches a complete revision provided by the maintainer, reads the blobs without checkout or script execution, refuses links, submodules, and unsafe paths, and applies limits of 2,000 files, 16 MiB per resource, and 64 MiB in total. Visual catalog research tools stay out of the package.

- After each CLI run, the processes belonging to the run are observed again, terminated, and confirmed as gone, including descendants that outlive the parent process. The result is kept in `processCleanup`; if it is not confirmed, the copy is not reused (`PROCESS_CLEANUP_UNVERIFIED`) until a new observation. On Windows, descendants whose intermediate process has already ended remain beyond the reach of the verification.

- CLI frames go through an iterative copy limited in depth and nodes, with redaction of strings and keys, before events, results, messages, and responses. Deep frames no longer interrupt processing with a stack overflow. Response deltas are released only per complete line and redacted with per-step state, avoiding credentials split across deltas; an incomplete line above 8 KiB is suppressed until the next line break, with a marker and a `response.truncated` event. Outputs and errors of native tests, reported evidence, and state restored from earlier versions are also redacted.
- Prompts, messages, and private memory with high-confidence credential formats are refused with `INPUT_SECRET_DETECTED`. Old memories with those values are read redacted and cannot be selected.

- MCP error responses go through diagnostic redaction before reaching the client, including errors generated by the SDK before the bridge's wrapper, such as unknown tool and argument validation. Valid responses, IDs, and hashes are not changed. Redaction of credentials in URLs now starts at the `://` delimiter, keeping linear time on long diagnostics.

- Discards lines above the limit until the next line break or EOF, without reinterpreting tails as events. Stdout recovers the next valid frames; after an excess on stderr, it explicitly suppresses the rest of that stream to avoid losing redaction context, without inspecting or keeping the rejected prefix.

- Makes `read_file`, `write_file`, and `edit_file` compatible with the file capabilities already selected, preserving path controls, read-only mode, and names in receipts. Rejects invalid modern arguments or ambiguous targets.

- Windows cleanup recognizes its own temporary files already gone and verifies the identity of existing directories before removal, preserving detected replacements.
- An explicit new test attempt after a local infrastructure failure reconciles leases and waits for initial recovery, without changing the previous record or releasing expired or canceled CLI sessions.

- Windows recovery separates the admission of grants from their revocation: it reconciles hardlinks and final reparse points created after the grant without following their targets, preserves other identities, and keeps cleanup limited. The profile SID is persisted before the fallible preparation steps; leases without a SID remain valid in `creating` when cleanup fails.
- Windows native results validate the nonce, termination, aliases, roots, and cleanup before accepting the execution. Preparation or cleanup failures return `BridgeError` with a redacted and limited diagnostic; secondary errors are appended to the original diagnostic.

- Discovery of the official CLI (`discover`) with strict validation of exit code 0 for `--version` and `--help`, non-empty output, and verification of the `stream-json` and `--sandbox` capabilities.
- Structured diagnostics and subprocess termination codes: `AGY_NOT_FOUND`, `AGY_PERMISSION_DENIED`, `AGY_PROBE_FAILED`, `AGY_INCOMPATIBLE`, `CLI_INPUT_FAILED` (closed stdin, EPIPE, or premature EOF), `AGY_IO_FAILED`, `AGY_PROCESS_FAILED`, `TASK_CANCELLED`, and `TASK_TIMEOUT`.
- The first recorded intent prevails in cancellations and timeouts, triggering termination of the process and descendants (without guaranteeing termination of processes that escape the process group or operating system permissions); preventive redaction of `stderr` and known error messages, without adding credentials to logs and without promising the absolute absence of unknown external secrets.
- Preventive secret preflight run after Git exclusions and `includePaths` and before the copy, blocking `.env`, `.env.local`, and other `.env.*` variants (except `.env.example`, `.env.sample`, `.env.template`, and `.env.dist`, which go through content inspection), `.envrc`, private keys, keystores, known credentials, and high-confidence content patterns; certificates, public keys, and synthetic test fixtures remain allowed.
- Previews and patch reading inspect files before staging and use a copy of the verified bytes. Per-file patch reading (`readProjectPatch`) extracts the slice directly from the reviewed and verified preview diff (`preview.patch`), strictly bound to the same SHA-256 hash without performing new unsafe reads of the shared index or the working tree; it restores the private index with `read-tree HEAD` after preview preparation (with a defensive quarantine fence if restoration fails). Blocked generated or modified files fail with `BLOCKED_FILE_DETECTED`, without changing the source.
- Snapshots, fingerprints, and forks respect the ignores of the source and the copy, omit blocked generated files, and reject contaminated baselines with `CONTEXT_CHANGED`.
- Artifact collection and reading reapply the secret policy and verify identity, size, and SHA-256, preserving limited pagination. Secret violations fail with `BLOCKED_ARTIFACT_PATH`.
- Configuration of exclusions (`BRIDGE_SECRET_EXCLUSIONS`) as a JSON array and of secret exceptions (`BRIDGE_SECRET_EXCEPTIONS` and runtime `ProjectLimits.secretExceptions`) as a strict versioned object (`{"version": 2, "namePatterns": ["fixtures/.env.local"]}`) with support for globs (`*`, `?`, `**`), basename matching without a slash, and case-insensitive matching; non-empty legacy arrays fail with a diagnostic guiding the migration without exposing secret values, while omissions or empty arrays normalize to an empty policy; in version 2, the exception skips only the credential file name check (`SECRET_FILE`), fully keeping the content scan and blocking (`SECRET_CONTENT`), under strict precedence where Git ignores and unsafe paths always win and an explicit deny beats exceptions.
- Stated limitations of the preflight, with no guarantee of detecting arbitrary secrets in source code, unknown formats, or encrypted data.
- Reporting of `blockedFiles` in the `copy.ready` event, containing only the path and reason (`SECRET_FILE`, `SECRET_CONTENT`, `SECRET_EXCLUSION`, `UNSAFE_PATH`) without exposing file content.
- Rigorous verification of file and byte limits during scan and copy, failure with `SOURCE_CHANGED` or `CONTEXT_CHANGED` on identity, size, or hash mutation, and prevention of silently omitting a baseline that becomes a credential.
- CLI execution environment isolated through `cliEnvironment`, with allowed default variables grouped, explicit opt-in through `BRIDGE_ALLOWED_ENV_VARS` (e.g., `["MY_TOOL_SETTING"]`, injection not being the default) with strict blocking of runtime injection variables (`NODE_OPTIONS`, `NODE_PATH`) and dynamic namespaces (`LD_*`, `DYLD_*`) in `loadConfig` and in direct calls to `cliEnvironment` (regardless of platform, mixed casing, or whitespace), with diagnostics that name the variable without exposing its value; preservation of `NODE_EXTRA_CA_CERTS`, legitimate opt-ins, and the official authentication and certificate context; omission by default of third-party credentials (AWS, GitHub, OpenAI, Stripe) and local agents (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`).
- Approval mode configurable through `BRIDGE_APPROVAL_MODE`: default `auto` when not configured (unset), with strict validation accepting only `auto` or `ask` (any other value results in a startup error).
- In `auto` mode (default), waives interactive MCP human confirmation forms for applying verified patches (`antigravity_integrate`) and validated sandbox policy updates (`antigravity_set_sandbox_policy`), without imposing extra manual confirmations on the caller, allowing it to propose narrow and verified grants needed by tests; agents delegated through `agy` (Gemini) do not choose, authorize, or provide permissions; strictly keeps SHA-256 hashes, acceptance criteria, review backed by the real files, current observed tests without failures, source-lock, CAS, and path protection.
- In `ask` mode (strict opt-in), always requires human confirmation through an MCP form for each integration and for sandbox policy updates, with no bypass for previously configured or remembered legacy roots; removal of the remember checkbox from the integration form.
- `antigravity_health` exposes `approvalMode` and `integrationApproval.mode` (`auto` or `ask`), as well as `integrationApproval.method` (`automatic` in `auto` and `mcp-form-elicitation` in `ask`).
- Documentation of configuration persistence in the MCP server's private startup environment (warning that PowerShell commands affect only the current shell session), requiring the connection to be restarted after changes.
- Bounded link-count compatibility in OneDrive cache environments: tolerance of an extra or transient nlink exclusively when reading assets with a trusted descriptor and pinned size and SHA-256, in the staging of the portable Node source with `expectedSha256`, and in the portable Node preparation lock (preserving device, inode, size, and the checked exact nonce/payload, with unlink only of the process's own entry to preserve aliases); rigorous validation where hash, size, identity, reparse marks, and directory layout remain mandatory, altered content is refused, and aliases are not modified. Runtime destinations, generic executables, and ACL grants still require a single link. `StateStore` has no generic support for cloud storage.
- Integration kept exclusively through MCP with no automatic fallback to the host and no change to the permissions of Codex or `agy`.
- Official `agy` authentication preserved through the operating system's native credential managers (Windows Credential Manager, macOS Keychain, Linux Secret Service), Gemini variables and endpoints, and ADC/Enterprise variables for compatibility (Enterprise flow not validated end to end).
- Git staging for Windows LPAC tests: automatic preparation of Git for Windows discovered in `PATH` for Node/npm tests and direct git commands, resolving cmd and bin launchers to the native binary in ucrt64/bin or mingw64/bin, preserving native executables and standalone installations, and refusing known invalid or unsafe layouts; copying only PE binaries, DLLs, and public helpers to a read-only single-link runtime without ACL grants on the original installation; environment isolation keeping in `PATH` only the runtime and the exact `System32`, `GIT_EXEC_PATH` at the directory in the runtime alias, a global configuration absent in scratch, `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0`, removal of injected `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, and `GIT_CONFIG_PARAMETERS` entries, and protected command configuration of `safe.directory` restricted solely to the exact list of verified repositories present in the copy at the start of the run: an empty reset (`VALUE_0=''`), the root of the verified copy alias (`VALUE_1`), and the roots of descendant repositories with a verified `.git` directory inside the copy (`VALUE_2..N`), with no `*` wildcard and no trust outside the copy, keeping normal Git checks for new repositories created after admission, with no inheritance of `.gitconfig`, credentials, or keys and no download; new temporary repositories created in the sandbox use isolated `GIT_DEFAULT_REF_FORMAT=reftable` (requiring reftable support in the installed Git, without converting existing repositories or changing the host, and recording the files backend limitation in LPAC without extra grants or UAC); optional absence of Git keeps Node/npm commands without Git functional, respecting copy limits and with no extra authorizations, host fallback, or network widening.
- Fixes Git access to the Null device in Windows LPAC with a temporary grant restricted to the run's SID when needed and allowed by the current token. Preserves the query without writing where default access exists and fails with a diagnostic where the grant is denied. v3 leases protect the pending grant and alias recovery; private Jobs allow verifying that processes have ended before cleanup.
- Protects local Git operations against executables in the project, fsmonitor, hooks, and global filters. Unifies the isolation and artifact helper, restricts the environment and `PATH`, preserves ignores, and limits time, output, and diagnostics. Git 2.32 becomes a requirement, validated before project operations. Adds a bounded post-termination tolerance deadline against retained pipes with an explicit failure in `GIT_CLEANUP_UNVERIFIED`, fences off reuse of copies with uncertain cleanup through a marker in the private baseline, unifies detection of commands with options that accept a value (`-c`, `--config-env`, `-C`, `--git-dir`, `--work-tree`, `--namespace`), restricts scope to global options, and ensures exclusion of both roots in managed operations.
- Fixes forks in Windows LPAC that failed when starting a Git transport through a shell. The baseline is rebuilt with native commands and accepted only when its tree matches the source, preserving the predecessor's HEAD and index.
- Refuses text patches whose bytes do not preserve the UTF-8 round trip, with `UNSUPPORTED_PATCH_ENCODING`, avoiding silent corruption. Git binary patches keep preserving the original bytes; `.gitattributes binary` is documented for non-UTF-8 content.
- Applies patches with the private baseline's configuration and fixed whitespace, avoiding execution of the source's local filters and changes to the approved bytes.
- Refuses forks when ignore rules come to restrict baseline files, avoiding exposure of their old content in deletion patches.
- Expands regressions for fsmonitor, configuration overrides, environment, forking, patch integrity, literal scope paths, and refusal of copies due to uncertain cleanup.

## 0.8.0

- Workflows with private JSON intermediates, final synthesis, explicit file inheritance, verifiable checkpoints, and resuming without repeating completed work.
- Per-step hooks for real criteria, grounded review, and observed tests, blocking pending or invalid evidence.
- Per-group budget with observed counters, session differences, and blocking of new calls when data is missing or the ceiling is reached.

- Serialized recovery of state locks, with file identity, ownership token, and idempotent release.
- Directed messages between nodes, compact receipts, and idempotent continuation through the CLI; dependencies wait for additional turns and cancellation includes continuations.
- JSON summary format to make the stored conclusion available in tasks with a native policy without an explicit schema.

- Groups with owners and dependencies, persisted admission, explicit resume, and joint waiting with cursors and limited messages.

- Private memory per project and specialist, with explicit selection, per-task snapshots, hash comparison, and paginated readers.

- Validated JSON results, artifacts with SHA-256, and paginated reading.
- Persistent per-specialist defaults for model, effort, skills, files, result, and tools.
- Trusted MCP catalog and tools selected per task, with native hooks, receipts bound to the conversation, and controls preserved across resumes and handoffs.
- Explicit diagnosis of the missing MCP permission in headless mode and protection of the auxiliary configuration in Windows LPAC tests.

## 0.7.1

- Removes the MCP Apps panel and its appearance features, keeping compact delivery, per-session messages, selected skills, concurrency, and prior integration authorization.
- Normalizes authorized roots with the native Windows resolver, including 8.3 aliases.

## 0.7.0

- MCP Apps panel with a list and a conversation in the style of Codex, locally discovered native features, technical output controls, and cards of real changes.
- Diff reading and per-file Undo only in the copy, bound to the current hash and to profile and run limits.

- Configurable prior authorization per exact project root to waive repeated forms, preserving criteria, hash, review, and current tests.

- Caller message box with idempotent receipts, sequential per-session dispatch, recovery without repeating uncertain sends, and continuation pointers.

- Optional delivery of compact public messages to the caller, with its own cursors, attribution, references to results, explicit history loss, and preservation of the event mode.

- Client-provided selected skill packages, prepared in the copy with UTF-8 resources, combined limits, immutable hashes, and preservation across resumes and transfers.
- Limited retries for transient Windows locks in atomic state writes, without removing the last valid state as an alternative.

## 0.6.1

- Exact preservation of the existing DACL when granting and removing temporary permissions of the Windows LPAC executor.
- Refusal of symbolic links and junctions in the final component of the Windows executable path.
- Sanitized diagnostics for portable cache inspection, with limited execution details and no raw output.
- Portable cache inspection without automatic PowerShell module loading, with a maximum deadline of 15 seconds.
- Test fixture adjusted for npm installations without a distributed `npmrc`.
- Package, plugin, and MCP server version updated to allow installation in a new Codex cache directory.

## 0.6.0

- The bridge's own test executor on Windows, isolated in AppContainer/LPAC and selected by default; `BRIDGE_TEST_EXECUTOR=agy` keeps the explicit legacy path and there is no host execution alternative.
- Global sandbox permission policy with query, change confirmed through an MCP form, and comparison by the previous hash. The agent calling the MCP selects, for each test, only permissions within the limits authorized by the user. The configuration is not forwarded to `agy`; the delegated Gemini cannot choose, authorize, or change it.
- Test evidence now distinguishes the Windows executor, the sandbox selection, and the policy hash. Known local execution records zero model tokens; optional repairs through `agy` keep the observed counters, including `null` when absent.
- Limited staging of Windows executables and of `npm`/`npm.cmd`, which runs the verified `node.exe` and `npm-cli.js`. Arbitrary batch files remain unsupported.
- Temporary two-level DOS aliases for the copy, runtime, and scratch, with three free letters from `D:` to `Z:`, identity and removal verification, and recovery of interrupted runs. They are local to the logon context, with no ACL on the volume root, UAC, or persistent mount.
- Known limitation: on Node 24.14.1/libuv 1.51, `child_process.spawnSync` with default pipes fails in LPAC and expires with exit code 124; inherited stdio and the real npm cycle do not demonstrate general compatibility. [libuv PR 5181](https://github.com/libuv/libuv/pull/5181/files), present in [libuv 1.53](https://github.com/libuv/libuv/releases/tag/v1.53.0), was applied to the portable runtime Node 24.21.0 LPAC1; the system Node 24.14.1 keeps the limitation.
- Node 24.21.0 LPAC1 runtime for Windows x64 published in an immutable Release, with base libuv 1.52.1 and only PR 5181 applied. The descriptor pins the URL, size, and SHA-256 of the three installed files: `node.exe`, `LICENSE`, and `build.json`. This build passed the LPAC regression with captured default pipes (1 test) and the isolation and lifecycle tests (22 tests, no failures or skips). Preparation is explicit.

## 0.5.2

- Restoration of a missing `PATHEXT` in the Windows subprocess for MCP clients with a reduced environment, preserving explicit values and sandbox permissions.
- Separate diagnostics for sandbox access failure, incomplete administrative setup, and denied bypass, with the cause reported by the runtime and bound to the test command.
- Refusal of receipts that declare a sandbox bypass, even with exit code zero.
- Regression with real PowerShell and native integration using the SDK's default environment, including executable resolution and denied external access.

## 0.5.1

- Task observation margin in tests widened from 5 to 30 seconds for copy preparation on Windows runners, preserving the concurrency, retention, approval, and execution timeout assertions.

## 0.5.0

- Per-environment tool profiles, with query and review limited to read tasks.
- Limited wait with MCP notifications per real event, cursors, and cancellation separate from execution.
- Structured transfer between roles with independent copies, history of reports, decisions, and criteria, bound to the hash of the files.
- Comparison of 2 to 4 models in read mode over copies of the same context, with divergences, failures, usage, and verification of current content.
- Explicit diagnosis of the limitations of permission responses and exact prior counting in the verified headless protocol.
- Custom roles through configuration, with inherited contracts, MCP discovery, and instructions preserved across resumes.

## 0.4.1

- Temporary Git snapshot inside the project copy for compatibility with the Windows AppContainer, with fingerprint exclusion and validated cleanup.
- Regression for an unavailable ambient temporary directory and real validation of execution, intact source, and denied external access.
- Guidance for the initial UAC setup of the Windows sandbox and token counters also in the real test's failure diagnostics.

## 0.4.0

- Acceptance criteria defined before the task, artifact checking, and review with citations verified by file and line.
- Integration conditioned on current verification, with detection of changed evidence and pending results.
- Asynchronous test execution in agy's native sandbox, with terminal receipts, exit code, fingerprints, and limited optional fixes.
- Paginated reading of per-file patches and of the final JSON, with hashes, Unicode cursors, and compact response options.
- Native normalization of 8.3 aliases in Windows tests and explicit declaration of the copy in the CLI workspace.
- Planning and review roles in query mode, JSON contracts, and checking of the findings' citations.
- Token usage per task, session, and model, with resume deltas, persisted baseline, and identification of unavailable data.
- Output schemas published in the 23 tools, with success/error contracts and validation by the SDK.
- Per-environment default model, persistent preference, and explicit Auto per task or for future tasks.
- npm package with an executable for npx, server included with no runtime dependencies, and tarball test on Windows/Linux.
- Health contract preserves textual availability diagnostics alongside the structured error format.

## 0.3.0

- Discard through MCP and automatic cleanup of finished copies, with a default retention of 7 days.
- Query mode with `agy --mode plan`, change verification, and integration blocking.
- Local recovery of tasks, sessions, events, and copies after a restart, with no automatic repetition of interrupted runs.
- Default limits of 10,000 files/256 MiB copied and 100 changed files.
- Line and file statistics in the preview, identification of binaries, and reported tests bound to the hash.
- MIT license, security and privacy policies, and notices for the distributed dependencies.
- Integration conditioned on confirmation through an MCP form, bound to the reviewed hash and checked again before application.

## 0.2.1

- Normalization of the Git root before path comparison on Windows.

## 0.2.0

- Temporary copies filtered by Git ignore rules and selection through `includePaths`.
- Mandatory sandbox, patch preview, and integration with validation of the hash and the source.

## 0.1.0

- stdio MCP server and plugin with a skill to run tasks through the official CLI.
- Model discovery, events, results, resume, and cancellation of tasks.
