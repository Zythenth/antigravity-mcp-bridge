# Token usage

Reference for the [core skill](../SKILL.md). Open it when reporting usage across resumed or failed tasks.

## Reporting tokens used

- When finishing, reporting a failure or ending a delegation, report the Gemini/agy tokens using `task.tokenUsage` or `black_gravity_usage`. Show `totalTokens` and, when available, input, output, reasoning and cache. Identify the data as usage reported by the CLI.
- For a sequence with resumes, check the session's consolidated total; do not add up the cumulative `result.usage` of each response. Per-task consumption already uses the difference from the previous counters. Preserve the distinction between retained tasks and the session's observed accumulated total.
- If there is `null`, `available: false`, `partial: true` or warnings, explain the limitation. Do not estimate missing counters, do not assign zero to a run without data and do not confuse tokens with the account's price or quota.
- Also report the consumption of failed tasks when available. Do not claim that tests ran only because the model consumed tokens; the terminal receipt is still required.
