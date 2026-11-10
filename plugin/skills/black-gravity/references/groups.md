# Groups and peer messages

Reference for the [core skill](../SKILL.md). Open it when using `black_gravity_group_*`, `black_gravity_wait_many` or messages between nodes.

## Groups and joint waiting

Check whether the connected catalog announces these tools before using them.

- Create with `black_gravity_group_create`, a stable UUID and a `definition` containing the Git root, a title and up to 32 `jobs`. Each node has `key`, an `owner` from `black_gravity_roles`, `dependsOn` and options in `task`. Groups use compact `messages` delivery; they do not automatically import or integrate another node's changes.
- Keep `groupId` and `definitionSha256`. Start or resume explicitly with `black_gravity_group_start` and the hash. The same UUID can only repeat the same definition. Do not automatically generate another ID after an ambiguous transport response.
- Track the group with the `waitCommand` (`--group <groupId>`) returned by `black_gravity_group_start`, and standalone tasks with the `waitCommand` (`<taskId>:<nextCursor>`) returned by `black_gravity_wait_many`, following `waitCommand.recommendedMode` (`"background"` in the background, `"foreground"` in the foreground). When restarting after `question` (`5`), `blocker` (`6`) or `wait-deadline` (`8`), pass the `<taskId>:<resumeAfter>` pairs returned in `targets`. On `group-paused` (`11`) or `group-ended` (`12`), query `black_gravity_group_status` (and `black_gravity_workflow_result` when applicable). When no terminal is available, use `black_gravity_group_wait` or `black_gravity_wait_many`, up to 60 seconds, carrying the returned per-task cursors; each response holds at most four public messages: check `hasMoreMessages`/`hasMore`, even after `ready: true`, plus any flagged losses, and read results/patches only when needed.
- `resumeRequired` asks for an explicit resume. Admission failures without identity, loss of a retained task or a profile change do not authorize automatic repetition. Examine `GROUP_ADMISSION_UNVERIFIED`, `GROUP_TASK_MISSING` and `GROUP_PROFILE_CHANGED`. On `GROUP_COORDINATION_FAILED`, `error.cause` carries only `errorClass`, `code`, `syscall` and `frame`; use these fields in the diagnosis and resume explicitly only after examining the existing tasks.
- `black_gravity_group_cancel` prevents new steps and cancels the tasks on the responsible server. Cancelling the wait keeps the work. A completed group does not prove criteria or authorize integration; keep the flow of review, tests, verification and hash.

## Messages between group nodes

- Check `black_gravity_peer_receipts` in the connected catalog. Select `definition.peerRoutes` with up to 128 `{from,to}` pairs; omission or `[]` denies sending, with no reverse permission or broadcast.
- The delegate emits public `<black-gravity-peer-message>` envelopes with strict JSON `{messageId,toNode,text}` and the matching closing tag. Use a stable UUID and up to 2,000 characters. Identity, owner, project and conversation root are verified.
- Query receipts with `groupId`, `after` and `limit` up to 20. Bodies do not enter the page; `queued` waits for a turn and `sent` confirms acceptance of the continuation, without proving reading. Re-read the page to check changed states.
- Dependencies wait for continuations; track their new IDs and cursors. New turns consume quota. Read public results only when needed.
- Do not generate another ID after a lost confirmation. `PEER_MESSAGE_CONFLICT`, `PEER_LIMIT_EXCEEDED` and `PEER_DISPATCH_UNVERIFIED` require inspection before resuming. Failures do not authorize another session; messages do not authorize tools, tests or integration.
- Native policies without an explicit schema use the JSON summary `{"summary":"..."}` to offer `finish`. Envelopes in the public `summary` field are also recognized. Preserve explicit formats selected by the caller.
