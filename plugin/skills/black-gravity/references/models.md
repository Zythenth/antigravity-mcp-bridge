# Model preference and comparison

Reference for the [core skill](../SKILL.md). Open it when checking or saving the default model, or asking several models for a second opinion.

## Model preference

- Prefer `model` in `black_gravity_run` for per-task selection. `black_gravity_set_model` persists the default in private state for future tasks, including after a restart. `model: null` persists Auto. The order is the task's choice, the saved preference, `BRIDGE_DEFAULT_MODEL` and the agy default. Check `black_gravity_get_model` before reporting the current preference.

## Model comparison

- When the request includes a second opinion from several models, choose 2 to 4 real IDs from `black_gravity_list_models`. Do not start an extra comparison without a reason within the scope: each opinion consumes quota. Get `black_gravity_context` and call `black_gravity_compare` with the current hash, a concrete scope and the models.
- Track all comparison tasks at once with the `waitCommand` returned by `black_gravity_compare` (following `recommendedMode`: in the background for `"background"`, in the foreground for `"foreground"`), or use `black_gravity_wait_many` / `black_gravity_wait` when no terminal is available. When it ends, query `black_gravity_comparison` and expose `startErrors`, missing models, failures, `unverified`, tokens and stale content. `ready` only means the retained tasks ended; `complete` requires every opinion available with its matching copy. If `contextStale` is set or `contextMatches` is not true, inspect again before recommending changes.
- Read each opinion and check findings against files and requirements. Synthesize what agrees, what diverges and which evidence resolves the divergence; do not decide by majority or turn an absence of findings into approval. The `identical` grouping is literal, `different` gathers interpretations of the same passage and `not-reported-by-all` includes passages not reported by all. Preserve the limitations and the functional authorship of each opinion by model ID.
- To integrate, go back to the implementation task, check the patch and the criteria and request the expected approval. Comparison does not modify the original or release integration.
