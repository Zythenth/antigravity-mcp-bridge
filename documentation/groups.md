# Groups, workflows, and specialist controls

## Task groups and joint waiting

The client creates a group with a stable UUID, Git root, title and up to 32 tasks. Each task has a unique key, an `owner` with a configured role, `dependsOn` and execution options under `task`. Unknown or duplicate dependencies, cycles and definitions over 4 MiB are refused. Up to 100 groups are retained.

| Tool | Purpose |
| --- | --- |
| `black_gravity_group_create` | Persists the definition without starting models. |
| `black_gravity_group_start` | Starts or resumes with `expectedDefinitionSha256`. |
| `black_gravity_group_status` / `black_gravity_groups` | Returns metadata, owners, dependencies and references. |
| `black_gravity_group_wait` | Waits for public messages or group termination. |
| `black_gravity_group_cancel` | Blocks new nodes and cancels tasks on the owning server. |
| `black_gravity_wait_many` | Waits for one to 32 standalone tasks with independent cursors. |
| `black_gravity_peer_receipts` | Returns compact receipts for messages between nodes. |
| `black_gravity_workflow_result` | Returns the final summary and reference after revalidating checkpoints. |

Example `definition` for `black_gravity_group_create`:

```json
{
  "workingDirectory": "<absolute-git-root>",
  "title": "Sequential inspection",
  "jobs": [
    { "key": "inspect", "owner": "implementer", "dependsOn": [],
      "task": { "prompt": "Inspect the selected files.", "mode": "read-only",
        "acceptanceCriteria": [{ "id": "inspection", "description": "Inspection grounded in the selected files" }] } },
    { "key": "check", "owner": "implementer", "dependsOn": ["inspect"],
      "task": { "prompt": "Check the task requirements.", "mode": "read-only",
        "acceptanceCriteria": [{ "id": "requirements", "description": "Requirements checked against evidence" }] } }
  ]
}
```

Repeat the same UUID and definition if the creation response was lost. A different definition with that UUID returns `GROUP_CONFLICT`. Start requires the returned hash. The server admits a node only after its prerequisites succeed. Failures and cancellations block dependents. Each node has its own copy. Dependencies order execution without applying changes between copies.

Groups use `messages` delivery. Native policy hooks enforce the human-configured file-tool ceiling and `finish` in each copy. MCPs come from task selection or an explicit role default. The canonical project root must stay separate from private bridge state. Waits return up to four messages total, one per task, with `nextCursor`, `oldestAvailable` and `truncated`. Carry forward each cursor. `hasMoreMessages` and `hasMore` can report unread messages even if `ready` is true. Responses omit prompts, tool history and full intermediate results. Use the chunk readers for those results. Cancelling a wait leaves execution running.

After a server restart, `resumeRequired` signals explicit resumption. The coordinator recovers admitted IDs and skips completed nodes. Interrupted admission with no verifiable identity returns `GROUP_ADMISSION_UNVERIFIED` and does not launch a duplicate. Changing an owner's profile pauses admission with `GROUP_PROFILE_CHANGED`. Retention-removed tasks report an error without rerunning. An unexpected coordination error pauses the group with `GROUP_COORDINATION_FAILED`. `error.cause` records only `errorClass`, `code` and `syscall` when present, and the first bridge function in the stack (`frame`). The server emits a stderr line with the same fields and no error message, task content or paths. A pause neither resumes nor repeats tasks.

`completed` reports that executions finished. Integration still requires review, tests, current verification and the hash for each task. Group records stay in private state until locally removed. Discard copies before deleting records. See the [privacy policy](../PRIVACY.md).

### Workflows and checkpoints

Add `workflow` to the group definition:

```json
{
  "finalNode": "check",
  "hooks": {
    "inspect": { "requireReview": true }
  },
  "fileSources": { "check": "inspect" }
}
```

The final node must depend directly or indirectly on all others. Every step needs `acceptanceCriteria`. The server checks file conditions before releasing dependents. Criteria without automatic checks need review citations grounded in actual files. `requireReview` also requires review when automated checks exist. `requireTests` requires observed execution evidence bound to the current patch and tree. `client-reported` receipts do not satisfy it. Direct tests require a write step based on `implementer` and a compatible executor. The absence of that capability gives no authorization for host execution.

JSON results and artifacts remain in private state. Implementation steps without an explicit output format use `{"summary":"..."}`. Role defaults and the other roles' contracts are preserved. Predecessors provide validated JSON and hashes to the next node, and the final synthesis receives completed intermediates. The UTF-8 context limit is 64 KiB. An overrun returns `WORKFLOW_CONTEXT_TOO_LARGE` without silent truncation or token estimates.

`fileSources` picks a direct dependency as a file baseline. The server checks its checkpoint and forks another copy. Other predecessors supply data only, with no automatic file merging. Omit `includePaths` and `skills` on the destination to retain the file and skill selection. Existing memory transfer rules still apply. Use `memory: []` to skip snapshot inheritance.

Checkpoints store hashes of the tree, patch, result, artifacts and validation. Results with pending tests or review are retained and pause the group. After verification, resume with `black_gravity_group_start` and the same definition hash. The server revalidates data without rerunning the completed call. Changed files or results return `WORKFLOW_CHECKPOINT_CHANGED`. A lost identity does not permit repetition. New messages cannot change a checkpointed step.

`black_gravity_group_wait` omits intermediates while retaining public questions, blockers and errors. `black_gravity_workflow_result` revalidates checkpoints and returns only the final public synthesis and hashed reference. A later failed run prevents a synthesis from being served as currently validated. Checks cover the stated conditions. Integration keeps its own tests, review and approval requirements.

### Observed group budget

Set `"budget": {"maxTotalTokens": 100000}` in the definition. Omission preserves existing behavior. With a ceiling, the group waits for observed counters from the current turn before admitting another. It includes continuations, node messages and model-assisted repairs. Resumes count the session delta, and known local executions without a model count as zero.

Status reports `observedTotalTokens`, the known subtotal, unmeasured tasks, remaining margin and budget status. Missing counters or lost retained identities block new calls with `GROUP_USAGE_UNAVAILABLE`. Reaching the limit pauses with `GROUP_BUDGET_EXCEEDED`. The ceiling is part of the immutable definition.

The budget stops new admissions based on observed usage. An admitted turn can exceed the ceiling. The CLI supplies neither an exact token forecast nor an advance price, and the bridge does not estimate missing data.

### Messages between nodes

The caller sets directed routes in `definition.peerRoutes`, for example `[{"from":"inspect","to":"check"}]`. Omission or `[]` denies sends. There is no implicit reverse route or broadcast. Limits are 128 routes, 20 messages per source node during a group and 100 per group.

The delegate sees permitted destinations and emits a public response like `<black-gravity-peer-message>{"messageId":"<stable-uuid>","toNode":"check","text":"finding"}</black-gravity-peer-message>`. Text is limited to 2,000 characters. The server checks owner, conversation root, project and definition. The destination receives data without tool or integration authorization.

Delivery waits until the destination is admitted and its active turn ends, using the official CLI continuation. Each new turn can consume quota. `queued` means waiting. `sent` means the continuation was accepted. Model consumption is unverified. Dependencies wait for additional turns, and joint wait tracks the latest one.

`black_gravity_peer_receipts` takes `groupId`, `after` and a `limit` of one to 20. Receipts show `agy-reported` provenance, destinations, status and SHA-256. Bodies and internal transport IDs are omitted. The cursor pages through a snapshot. Reread a page to check updated states. The destination's public results may reproduce received data and remain available through the normal readers.

The same ID and content preserve identity. Conflicting content pauses with `PEER_MESSAGE_CONFLICT`. Limits and truncation pause with `PEER_LIMIT_EXCEEDED`. Ambiguous confirmation requires inspection and explicit resumption with the persisted ID. A denied route or terminal destination fails without starting another session. Cancellation reaches active continuations and terminal groups reject new turns.

Implementation tasks under native policy without an explicit output schema use `{"summary":"..."}` to make the guarded `finish` call available. Explicit schemas and other role contracts are preserved. Envelopes in the public `summary` field are recognized without exposing private reasoning.

## Private project and specialist memory

The server keeps memory in private state, partitioned by canonical Git root and specialist identifier. It imports no project file automatically.

| Tool | Purpose |
| --- | --- |
| `black_gravity_memory_list` | Metadata, hashes, sizes and limits without text. |
| `black_gravity_memory_read` | Chunked text bound to `expectedSha256`. Follow `nextOffset`. |
| `black_gravity_memory_write` | Writes text reviewed by the caller. `expectedSha256: null` creates, and the current hash replaces. |
| `black_gravity_memory_remove` | Removes only the version matching the supplied hash. |

Example selection in `black_gravity_run` after reading and checking the memory:

```json
{ "memory": [{ "specialist": "reviewer", "sha256": "<current-64-character-hash>" }] }
```

The caller selects up to eight entries. Selected text goes to the CLI as reviewable data within the total prompt limit. It grants no permissions and leaves task instructions in force. Task responses, including compact ones, contain only memory metadata. Memory text is not staged as an auxiliary file or integrated into the project.

A specialist can set `memory` as an explicit default. An empty list overrides it. Resumes keep original snapshots even after stored entries are replaced or removed and reject resubmitting `memory`. Handoffs inherit snapshots by default, with an explicit selection or `memory: []` available.

Global defaults are 100 entries, 1 MiB of UTF-8 text and 64 KiB per entry. Writes use hash comparison and an interprocess lock. Version mismatches return `MEMORY_CHANGED`. Links, storage junctions, corrupt files and inconsistent hashes are refused. The `query` and `review` profiles can only list and read.

High-confidence credential patterns in memory, prompts or messages are refused with `INPUT_SECRET_DETECTED`. Older entries containing those patterns are redacted on read and cannot be selected.

Removing a memory entry leaves snapshots in retained tasks. Discarding a copy also preserves those records. See the [privacy policy](../PRIVACY.md) for deleting local state. The bridge provides no encryption of its own.

## Specialist and task controls

Custom roles accept `defaults` for `model`, `effort`, `skills`, `includePaths`, `outputSchema`, `artifactPaths`, `deliveryMode`, `timeoutSeconds`, `allowedTools`, `mcpServers` and `memory`. Explicit arguments replace whole fields without merging lists. `model: null` keeps Auto. Resume retains the original snapshot. A custom result schema requires the `implementer` base. Other roles keep their own contracts.

Configure the server environment:

- `BRIDGE_ALLOWED_AGY_TOOLS` is a JSON array ceiling for native tools. It accepts `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content` and `finish`. Finishing is implicit. A configured ceiling applies even without task selectors. Invalid JSON, a non-list or more than five items falls back to `[]` and only implicit finish. Unknown or non-string entries are skipped individually and duplicates collapse. Health reports issues without stopping the server. Setting this variable keeps native policy enforcement active.
- `BRIDGE_MCP_CATALOG` lists up to 20 trusted servers, each with an `id`, transport and `tools: [{name, readOnly}]`. Transport is an absolute `command` with optional `args/env/cwd`, or an HTTPS or loopback HTTP `serverUrl` with optional `headers`. `nativeServerName` sets a user-defined stable native alias.

In the current CLI, `read_file` maps to `view_file`, `write_file` to `write_to_file`, and `edit_file` needs `replace_file_content` or `multi_replace_file_content`. These native names use `Path`. Existing selectors still work. The hook rejects ambiguous targets and applies the same path and read-only checks. The receipt records the actual call name.

Consult `black_gravity_get_agent_policy` before choosing `allowedTools` and `mcpServers: [{serverId, tools}]` in `black_gravity_run` or `black_gravity_handoff`. The public catalog shows only IDs, aliases, descriptions and tools. Transports and credentials stay out of the prompt and returned policy. Empty lists select implicit finish and no MCP servers. With neither global configuration nor selectors, older tasks keep their behavior. An old session without controls requires a new task after configuring a ceiling.

Native hooks restrict files to the copy, block unselected tools and protect auxiliary configuration. Reads in `.agents` are limited to explicitly supplied skill files. Helpers are hash-checked and omitted from patches. Finish needs a fresh receipt tied to policy and conversation. A previous finish does not validate a resume. Handoffs create independent controls and receipts, retaining the selection and dropping tools incompatible with read-only mode.

The CLI also requires native `mcp(alias/tool)` authorization in its settings. The bridge does not grant it or change global settings. Missing permission appears as `AGY_MCP_PERMISSION_REQUIRED`. Trusted stdio servers run on the host. Hooks constrain model calls and do not isolate service internals.

The Windows LPAC executor remains available. The auxiliary MCP configuration has a protected DACL and receives no test-process access. Tool selection grants no terminal access. The legacy `BRIDGE_TEST_EXECUTOR=agy` refuses direct tests under this policy with `POLICY_TEST_EXECUTOR_UNAVAILABLE`.
