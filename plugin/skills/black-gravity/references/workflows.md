# Server-run workflows

Reference for the [core skill](../SKILL.md). Open it when using `definition.workflow`, `black_gravity_workflow_result` or `definition.budget`.

## Workflows run by the server

- Check the connected catalog. Configure `definition.workflow` with `finalNode`, optional per-node `hooks` and `fileSources` to inherit files from a direct dependency. The final node must reach every predecessor. Do not merge copies implicitly.
- Define per-step criteria and JSON formats with the needed content. The server keeps intermediate outputs and validates hashes before sending them as data to the next steps. Context limit: 64 KiB UTF-8; reduce the declared output if it is exceeded.
- `requireReview` requires a current review with real quotes through `black_gravity_verify`. `requireTests` requires an observed run on a compatible executor; `black_gravity_record_test` is a client report and does not satisfy this hook. Direct tests require a write step based on implementer.
- Examine `WORKFLOW_REVIEW_REQUIRED`/`WORKFLOW_TEST_REQUIRED`; complete the verification and resume the same group with its hash. Do not repeat the completed task or generate another ID to work around a checkpoint or an admission error.
- File inheritance keeps the selection and skills; omit these fields at the destination. If needed, use `memory: []` so as not to inherit memory. The server checks the tree and the patch before the transfer.
- The workflow wait omits ordinary intermediate messages. Use `black_gravity_workflow_result` for the synthesis and its reference; read details only when needed. Later changes or failed runs invalidate the validated delivery. Completion does not authorize integration.
- `definition.budget.maxTotalTokens` limits new calls by the observed consumption, including continuations. With a ceiling, wait for the active turn; lack of measurement or exhaustion pauses admissions. An accepted turn may exceed the ceiling; do not promise exact prices or prior token counts.
