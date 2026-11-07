# Session messages and task control

Reference for the [core skill](../SKILL.md). Open it when using `antigravity_send_message`, discard or cleanup, or on `SERVER_RESTARTED` or `ORPHAN_PROCESS_RUNNING`.

## Talking to the session

Use `antigravity_send_message` with taskId, a stable UUID messageId and text of up to 2,000 characters. Keep the ID and the text: repeating the same values queries the existing receipt. On an ambiguous transport error, do not automatically generate another ID. `queued` waits for the current turn; `sent` reports acceptance of a continuation, without proving that the model read it. Failure or cancellation does not authorize automatic repetition and additional quota consumption.

Follow `continuationTaskId` with cursor zero. If `continuationPending` is active without an ID, keep waiting on the current turn; `ready` ends that turn, not the pending sequence. Resuming keeps the session, copy, selection, skills, role, mode, criteria and limits. Text does not approve integration or permissions.

## Continuation and control

- Use the `taskId` of a completed task with `antigravity_resume` to continue in the same copy; provide exactly one of `taskId` and `sessionId`, the latter obtained through `antigravity_status`. `antigravity_sessions` lists persisted sessions and `antigravity_tasks` recovers task IDs after a restart. Interrupted runs are not repeated: examine `SERVER_RESTARTED` and the copy before starting other work. If there is `ORPHAN_PROCESS_RUNNING`, wait for the registered process to end; do not try to apply or discard its copy.
- When the user asks for cancellation, call `antigravity_cancel` with the `taskId` and confirm the status. Cancellation ends the local process; partial changes may remain.
- When the user wants to discard the work, call `antigravity_discard` after the task ends. The removal reaches every task resumed in the same copy. Use `antigravity_cleanup` to remove expired copies; the default retention is 7 days. `antigravity_health.maintenanceIssues` with `copy-cleanup` indicates a failure of the automatic cleanup (the server keeps running and tries again every minute); examine the `code` before calling `antigravity_cleanup`.
- After a failure or timeout, examine the events and the copy before repeating the task. Do not start a new run automatically if it could repeat effects or consume quota.
