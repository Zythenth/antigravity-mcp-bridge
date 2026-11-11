# Configuration, isolation, and security

## Architecture

Black Gravity was previously named Antigravity MCP Bridge and distributed as `antigravity-mcp-bridge` through the published 0.9.0. See [available versions](setup.md#available-versions) for the current names.

```text
Codex -- MCP stdio --> bridge -- subprocess --> official agy --> Antigravity
Codex <-- structured events and results <-- bridge <-- stdout/stderr
```

Codex can start tasks, follow events, inspect results and cancel processes. The bridge inspects candidate project files locally during preflight. The official `agy` CLI handles service communication, and the bridge does not read private endpoints, cookies or CLI authentication stores.

## Git isolation and patch encoding

Local Git uses a dedicated environment with `PATH` restricted to directories outside the project and copy. Hooks, fsmonitor and global execution settings are disabled. Ignore rules are queried separately, preserving the authentication policy of `agy`. When Git termination cannot be confirmed after a termination request and bounded grace period (for example, when pipes remain open), the operation fails with `GIT_CLEANUP_UNVERIFIED`. The bridge destroys stdio and marks the private baseline to block reuse, preview, integration or unsafe deletion of potentially held resources.

Text patches containing non-UTF-8 bytes fail with `UNSUPPORTED_PATCH_ENCODING`. Mark files as `binary` in `.gitattributes` to keep original bytes in Git binary patches. Before starting a write task, the bridge also refuses files that are non-UTF-8 and would produce text diffs. This includes a set `diff` attribute or an unspecified one with no NUL byte in the first 8,000 bytes. An explicitly unset `diff` attribute, as with `binary`, prevents a text diff. The bridge reports those paths with `UNSUPPORTED_TEXT_ENCODING` before starting the CLI. Mark them as `binary`, leave them out of `includePaths` or convert them to UTF-8. Read-only tasks generate no patch and are exempt from this refusal.

## Host permissions

`black-gravity permissions` prints a permission block generated from the tool annotation table. It writes only to stdout. Review and merge the output into the host configuration.

1. Print the block from an installed or source build.

   ```powershell
   black-gravity permissions --host claude-code
   node .\dist\src\index.js permissions --host claude-code --preset delegation
   ```

2. Select a preset. The default `connector` allows tools with `readOnlyHint: true` and asks before all other tools. `delegation` allows the delegation flow and asks only for `DELEGATION_ASK_TOOLS` in the code: `black_gravity_integrate`, `black_gravity_discard`, `black_gravity_cleanup`, `black_gravity_memory_remove`, `black_gravity_set_sandbox_policy`, `black_gravity_cancel` and `black_gravity_group_cancel`. Match `--profile` to `BRIDGE_TOOL_PROFILE` (default `full`) so the output covers only registered tools. Match `--server-name` (default `black-gravity`) to the registered server key because rules use `mcp__<server>__<tool>`.
3. Add repeatable `--deny <tool>` options using a bare tool name or `mcp__<server>__<tool>`. An incorrect prefix, unknown tool or tool outside the profile produces an error and exit code 2 with no stdout output.
4. For Claude Code, merge the `allow`, `ask` and `deny` arrays into `permissions` in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`, keeping existing rules. Start a new session. To try the block first, save it to a separate file and start `claude --settings <file>`.
5. For Codex, use `--host codex`. The TOML prints one `[mcp_servers.<server>.tools.<tool>]` table per tool with `approval_mode = "approve"` or `approval_mode = "prompt"`, and lists denied tools in `disabled_tools` under `[mcp_servers.<server>]`. Merge into the existing server entry in `~/.codex/config.toml` and combine any existing `disabled_tools` lists in one key. The keys were checked against the Codex configuration schema. Per-tool `approval_mode` behavior in a Codex session remains unverified. Codex ignores unknown keys, so inspect the result with `codex mcp get <server> --json`.

Host approval and [bridge approval](review-and-integration.md#approval-and-integration-modes) both apply. A host rule allowing `black_gravity_integrate` leaves the bridge form active in `ask` mode. A host `ask` rule still applies in bridge `auto` mode. All bridge verification, test and review requirements apply in both modes.

## Bundled Anti-AI Craft

The package includes a verified six-skill [Anti-AI Craft snapshot](https://github.com/Zythenth/anti-ai-craft). Every new task gets `anti-ai-code` and `anti-ai-security` in the copy, and Gemini is instructed to read them before starting. `anti-ai-design`, `anti-ai-design-flow`, `anti-ai-audit` and `anti-ai-remediate` appear as a catalog of names, descriptions and paths (up to 8 KiB). Their bodies, references and images stay outside the prompt and are available on demand, read-only, in a private per-revision copy under `<state>/anti-ai-craft/` added with `--add-dir`. Under tool policy, hooks allow only reads there. Gemini selects relevant skills without requiring their literal names in the task.

Before each new task, the bridge verifies file size and SHA-256 against the snapshot manifest. Missing or altered content fails with `CRAFT_SNAPSHOT_INVALID` or `CRAFT_SNAPSHOT_MISSING`. Reinstall the bridge version to restore the snapshot. The bridge performs no automatic download. Resumes and handoffs retain the original snapshot. The permanent skills count toward the eight-package and 1 MiB limits. Identical same-name skills are deduplicated. Conflicting content fails with `SKILL_CONFLICT`. Skill files are excluded from the project patch.

Set `BRIDGE_ANTI_AI_CRAFT=off` to disable the policy globally. `BRIDGE_ANTI_AI_CRAFT_DIRECTORY` selects a snapshot in the same format, verified against its manifest. The bundle provides skills without installing the Anti-AI Craft MCP, Graphify, Python or other tools mentioned by those skills. The visual library images retain their original licenses. See [dependency notices](../THIRD_PARTY_NOTICES.md).

## Client-provided skills

Codex or another client can send selected skills in `black_gravity_run.skills`. Compact delivery returns only the name, hash and file count in `providedSkillSummaries`. A package contains `SKILL.md` text and optional text resources whose paths are relative to the skill:

```json
{
  "workingDirectory": "/absolute/project/path",
  "prompt": "Use the review-style skill to review the project.",
  "mode": "read-only",
  "skills": [{
    "name": "review-style",
    "content": "---\nname: review-style\ndescription: Review rules\n---\nRead references/check.md before reviewing.",
    "resources": [{ "path": "references/check.md", "content": "Check the requirements against the actual files." }]
  }]
}
```

The bridge stages only the supplied packages under `.agents/skills/<lowercase-name>/` inside the copy. It preserves the declared name and UTF-8 bytes, including names such as `Presentations`. Metadata includes names, relative paths and hashes without repeating skill text. Clients select resources explicitly and keep private files and credentials out. Global skills are not discovered or imported automatically.

Limits are eight skills, 100 resources per skill and 1 MiB of text total. These files count toward copy limits. Absolute paths, traversal, device names, case aliases, links and collisions with existing directories are rejected. Staging does not run supplied scripts. Tool dependencies must be present in `agy`, and a skill grants no permissions.

Resumes and handoffs retain the original packages and hashes. Resumes reject a new `skills` argument, even an empty list. Adding, changing or removing a supplied resource invalidates verification. Auxiliary files stay out of project patches. Omit `skills` to keep using eligible skills already in the project.

## Test sandbox policy

`black_gravity_get_sandbox_policy` returns the normalized global policy and `sha256` for Windows LPAC tests. This policy caps `readRoots`, `writeRoots`, `network`, `childProcesses` and `maxOutputChars`. Initially it grants no external roots, disables networking, allows child processes and limits output to 4,000 characters.

For each Windows `black_gravity_test`, the MCP caller can choose `sandbox: { readPaths, writePaths, network, childProcesses, maxOutputChars }` within the ceiling. The bridge rejects paths outside approved roots and paths that overlap the original project, credentials, bridge storage, controlled temporary files, links, aliases or other protected paths. Test evidence records the selection and policy hash. The legacy `agy` executor retains its existing behavior and rejects an explicit selection.

To change the ceiling, read the policy and call `black_gravity_set_sandbox_policy` with its current hash and the proposal. `auto` applies validated proposals without a form. `ask` requires an interactive MCP form and checks the previous hash. Comparing the hash prevents overwriting a policy changed during evaluation. The caller selects verified, narrow grants per test within the policy. Delegated agents have no authority to choose, authorize or modify grants. Changes apply to new and queued tests. Active grants remain in force, and the bridge has no fallback to host execution.

Use specific verified directories, such as `"<approved-read-root>"` and `"<approved-write-root>"`, instead of entire disks or paths assumed to exist on another computer. In `ask`, confirm the ceiling in the form. In `auto`, submit the validated proposal. Select narrow subsets for the test.

## Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_APPROVAL_MODE` | `auto` | `auto` skips forms for validated integration and sandbox policy updates. `ask` always requires a human MCP form, including for configured or remembered roots. |
| `BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS` | `[]` | JSON array of up to 20 absolute project directories. Invalid entries grant nothing and are skipped with one stderr warning. Health reports the variable, index and reason in `configurationIssues`, without the path. |
| `BRIDGE_CUSTOM_ROLES` | `[]` | Up to 20 JSON roles with name, base and instructions. Invalid and duplicate-name entries are ignored without granting anything, with one stderr warning and a `configurationIssues` entry. |
| `BRIDGE_MCP_CATALOG` | `[]` | Up to 20 JSON MCP servers for the agent policy catalog. Invalid and duplicate-ID entries are ignored without granting anything, with one stderr warning and a `configurationIssues` entry. |
| `BRIDGE_TOOL_PROFILE` | `full` | Tool catalog: `full`, `query`, `review` or `implementation`. |
| `BRIDGE_TEST_EXECUTOR` | `windows-lpac` on Windows, `agy` elsewhere | Executor for `black_gravity_test`. `agy` selects the legacy executor on Windows. |
| `BRIDGE_WINDOWS_NODE_RUNTIME` | `system` | Windows can use `system` or the prepared portable runtime. The distributed plugin sets `portable`. |
| `BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY` | `~/.black-gravity/windows-runtimes` | Optional trusted directory outside projects for sharing the portable cache across state directories. Only the startup environment can set it. Invalid values (relative paths, NUL, UNC, devices, colons, `.`/`..` or a volume root) are reported in `configurationIssues`. There is no fallback to the default. Portable mode becomes unavailable with `INVALID_CONFIGURATION`; `system` remains available. |
| `BRIDGE_ANTI_AI_CRAFT_DIRECTORY` | Empty | Absolute path to a verified Anti-AI Craft snapshot. A relative path or NUL is reported in `configurationIssues` and tasks fail with `INVALID_CONFIGURATION` when Craft is active. There is no resolution against the current directory or fallback to the bundled snapshot. |
| `AGY_PATH` | `agy` | Official CLI. Relative paths with separators (e.g. `bin/agy`, `.\agy`), incomplete Windows drive paths (e.g. `C:agy.exe`) and values with NUL are invalid. No `PATH` fallback. Health reports the issue and `installed: false` with a neutral path, and tasks fail with `INVALID_CONFIGURATION`. Bare names and absolute paths, including extended-length Windows paths, work as usual. |
| `MAX_CONCURRENT_TASKS` | `1` | Concurrent processes. |
| `MAX_QUEUED_TASKS` | `20` | Queued tasks. |
| `MAX_RETAINED_TASKS` | `100` | Retained persisted tasks. |
| `DEFAULT_TIMEOUT_SECONDS` | `1800` | Default execution deadline. |
| `EVENT_BUFFER_SIZE` | `2000` | Events retained in memory. |
| `BRIDGE_MEMORY_MAX_ENTRIES` | `100` | Global private entries, up to 10,000. |
| `BRIDGE_MEMORY_MAX_BYTES` | `1048576` | Global UTF-8 memory bytes, up to 64 MiB. |
| `BRIDGE_MEMORY_MAX_ENTRY_BYTES` | `65536` | Per-entry bytes, up to 1 MiB and bounded by the global limit. |
| `BRIDGE_STATE_DIRECTORY` | `~/.black-gravity` | Private task and session directory. Relative paths, Windows root-relative or drive-relative paths such as `\state` and `C:state`, NUL, reserved Windows characters, symlinks and junctions are invalid. There is no fallback or resolution against the current directory. The server enters degraded mode and responds to `initialize`, `tools/list` and `black_gravity_health`. Health omits `waitCommand` and reports `not-absolute`, `invalid-entry`, `link`, `not-directory` or `unusable`. State operations fail with `INVALID_STATE_DIRECTORY`. |
| `BRIDGE_DEFAULT_MODEL` | Empty | Initial model if no preference is saved. |
| `BRIDGE_SECRET_EXCLUSIONS` | `[]` | JSON array of relative file patterns excluded from copies. Any problem invalidates the list and rejects tasks, copies and preflight with `INVALID_CONFIGURATION`. |
| `BRIDGE_SECRET_EXCEPTIONS` | `{"version":2,"namePatterns":[]}` | Strict version-2 JSON object with relative glob patterns. Skips only known credential filename checks (`SECRET_FILE`), retaining incremental content scanning (`SECRET_CONTENT`). Invalid entries grant no exceptions and produce one stderr warning and a `configurationIssues` entry. |
| `BRIDGE_ALLOWED_ENV_VARS` | `[]` | JSON array of additional exact environment variable names for CLI subprocesses. Invalid or forbidden injection entries are ignored with one stderr warning and a `configurationIssues` entry. |
| `MAX_COPY_FILES` | `10000` | File limit for copies. |
| `MAX_COPY_BYTES` | `268435456` | Copy byte limit (256 MiB). |
| `MAX_CHANGED_FILES` | `100` | Changed file limit for review and integration. |
| `COPY_RETENTION_HOURS` | `168` | Retention period for finished copies. |
| `MAX_PROMPT_CHARS` | `50000` | Maximum submitted prompt length, including criteria, transferred context and bridge and role instructions. |
| `FORBIDDEN_DIRECTORIES` | Empty | Absolute blocked directories separated by `;` on Windows. Relative paths and NUL are invalid, are reported in `configurationIssues`, and disable the list without resolving paths against the current directory. Tasks, groups, file listings and sandbox policies then fail with `INVALID_CONFIGURATION`. |

Set variables persistently in the private server startup environment. PowerShell assignments such as `$env:VAR = ...` apply only to the current shell. Restart the MCP connection after any change. The bridge validates inputs and directories, spawns tasks without a shell and requires `--sandbox`. It never passes `--dangerously-skip-permissions`. Windows tests default to the bridge LPAC executor. Keep private files and credentials out of prompts and out of copies through Git ignores. Select only necessary paths with `includePaths`. See the official [sandbox](https://antigravity.google/docs/sandbox/) and [headless](https://www.antigravity.google/docs/cli/headless/) documentation.

### Secret exclusion and exception patterns

`BRIDGE_SECRET_EXCLUSIONS` is a JSON array of patterns relative to the project root. `BRIDGE_SECRET_EXCEPTIONS` uses a strict versioned object, for example `{"version": 2, "namePatterns": ["fixtures/.env.local"]}`. Both accept glob wildcards `*` (one segment), `?` (one character) and `**` (multiple directories). Traversal (`..`), NUL and absolute paths are rejected. Names without slashes match the basename in any directory, and `**/` and `/**/` match zero or more intervening directories. Matching is case-insensitive.

An invalid exception grants nothing. For exclusions, any error (invalid JSON, non-array, non-string, empty string, NUL, absolute path or `..`) disables the entire list. Task admission, baseline inspection, preflight and copy creation then fail with `INVALID_CONFIGURATION` before copying. Deny patterns are never silently dropped. The server stays up and health reports issues without configured values. Omission or `[]` normalizes to an empty list.

Use narrow exceptions for reviewed files without real credentials, such as the synthetic fixture in `BRIDGE_SECRET_EXCEPTIONS='{"version": 2, "namePatterns": ["fixtures/.env.local"]}'`. Precedence is:

1. Git ignores and unsafe path checks (`UNSAFE_PATH`) take priority over all exceptions.
2. An explicit exclusion (`BRIDGE_SECRET_EXCLUSIONS`, `SECRET_EXCLUSION`) takes priority over an exception.
3. A version-2 exception skips only the known filename check (`isKnownCredentialFile`, `SECRET_FILE`). All permitted content is still inspected by `detectSecretContent` and can be blocked with `SECRET_CONTENT`.

Preflight cannot guarantee detection of arbitrary secrets in source code, proprietary or unknown formats, encrypted data or obfuscated files.

### Safeguards for previews, context, and artifacts

Preview inspects known credential names and patterns before staging a copy of verified bytes in private Git and restores the private index with `read-tree HEAD`. Per-file reads (`readProjectPatch`) extract the slice directly from the reviewed and verified `preview.patch`, bound to its SHA-256. They avoid rereading the shared index or work tree. Generated or modified policy-violating files fail with `BLOCKED_FILE_DETECTED`. Changes during preparation invalidate the operation. Index restoration leaves existing Git objects in place.

Snapshots, fingerprints and forks apply origin and copy ignore rules and secret policy. Blocked generated files are omitted. A newly blocked baseline file causes `CONTEXT_CHANGED`. Supplied skills and execution policies retain their own integrity checks.

Artifact collection and reads reapply name, content and exclusion policies. Secret violations fail with `BLOCKED_ARTIFACT_PATH`. Reads verify bytes against the inspection and reference SHA-256 and keep only the requested window in memory. Earlier references still require path and policy checks. These checks cover recognized formats and cannot detect every secret or eliminate every filesystem race.

### CLI subprocess environment

`cliEnvironment` filters the CLI subprocess environment. The bridge logs no environment values and passes no tokens as arguments. Opt in to additional exact names with `BRIDGE_ALLOWED_ENV_VARS='["MY_TOOL_SETTING"]'`. Defaults allow no arbitrary injection or opt-in variables. Matching is case-insensitive on Windows and case-sensitive on Unix, Linux and macOS. Deduplication and `PATHEXT` are preserved.

Runtime injection and library preload names (`NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*`) are forbidden in the allowlist and direct `cliEnvironment` calls, including case and whitespace variants on all platforms. The server ignores those and invalid names in `BRIDGE_ALLOWED_ENV_VARS` and reports `forbidden-name` or `invalid-name` without echoing values. Direct API calls throw. Legitimate non-injecting opt-ins, certificates such as `NODE_EXTRA_CA_CERTS`, system and profile settings, native keyrings, proxies, corporate certificates and official Google/ADC authentication are preserved. Other provider and third-party API credentials such as AWS, GitHub/GH, OpenAI and Stripe and local agents such as `SSH_AUTH_SOCK` and `GPG_AGENT_INFO` are omitted by default.

Default names grouped as in `cliEnvironment`:

- **System and executable resolution** — `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `ComSpec`, `WINDIR`, `SHELL`, `TERM`, `COLORTERM`.
- **User and profile directories** — `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `USER`, `LOGNAME`, `USERNAME`.
- **Temporary directories** — `TEMP`, `TMP`, `TMPDIR`.
- **Locale, language and time zone** — `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TZ`.
- **XDG directories and session authentication or native keyring** — `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `XDG_DATA_DIRS`, `XDG_CONFIG_DIRS`, `DBUS_SESSION_BUS_ADDRESS`, `GNOME_KEYRING_CONTROL`, `GNOME_KEYRING_PID`, `SECURITYSESSIONID`.
- **SSH remote session context without credentials** — `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`.
- **Network and proxy settings** — `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`.
- **Corporate and custom root SSL/TLS certificates** — `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`.
- **Official Google/Gemini authentication and custom endpoints** — `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_UNIVERSE_DOMAIN`.
- **Windows environment, architecture and domain context** — `OS`, `PROCESSOR_ARCHITECTURE`, `PROCESSOR_ARCHITEW6432`, `NUMBER_OF_PROCESSORS`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `CommonProgramFiles`, `CommonProgramFiles(x86)`, `USERDOMAIN`, `USERDNSDOMAIN`, `COMPUTERNAME`.

Common diagnostics include `AGY_NOT_FOUND`, `AGY_PERMISSION_DENIED`, `AGY_PROBE_FAILED`, `AGY_INCOMPATIBLE`, `CLI_INPUT_FAILED`, `AGY_IO_FAILED`, `AGY_PROCESS_FAILED`, `TASK_CANCELLED`, `TASK_TIMEOUT`, `AGY_AUTH_REQUIRED`, `MODEL_NOT_AVAILABLE`, `INVALID_WORKING_DIRECTORY` and `QUEUE_FULL`. For `AGY_AUTH_REQUIRED`, sign in to interactive `agy`. If tools are missing from Codex, verify installation with `codex plugin list --json` and open a new conversation.
