---
name: anti-ai-code
description: "Review or implement scoped code changes, avoiding unverifiable, fragile, invented, verbose, or overengineered behavior. Use when the request involves modules, diffs, tests, fixes, refactoring, or implementation requirements; do not use for purely visual design, a broad read-only audit, application of numbered findings, or translation. Read the repository, cite evidence by file and line, and edit only when requested, prioritizing a direct, cohesive, minimal solution."
---

# Anti-AI Code

Treat “anti-AI” as verifiable engineering, not authorship detection. Avoid code that looks sophisticated but adds volume, layers, options, or comments without solving a concrete need. Patterns addressed here may also be written by humans. Look for real defects first and distinguish bugs, vulnerabilities, traditional smells, heuristics, and preferences.

Use `$anti-ai-audit` for a broad read-only scan, `$anti-ai-security` for abuse paths, and `$anti-ai-remediate` when approved IDs already exist. This skill is for scoped implementation or review.

## Prepare

1. Confirm the scope, authorization to edit, and expected outcome.
2. Read AGENTS.md, README, documentation, configs, manifests, lockfiles, scripts, neighboring code, tests, and Git history when they help.
3. Record the architecture, conventions, public API, invariants, pre-existing changes, and official commands.
4. State only assumptions, competing interpretations, and material trade-offs. Investigate facts in the repository; order decisions by contract/invariant, boundary/API, and implementation. Low-risk ambiguity may be assumed and stated explicitly; a contract or security decision must be raised with the user along with a recommendation, rationale, and consequence. Continue independent branches.
5. Reproduce the behavior before calling something a bug.
6. Verify an API in this order: repository/lockfile/imports/types; installed package or CLI; official documentation for the exact version; release notes or official repository. Do not infer across versions, languages, or SDKs.
7. Separate verified fact, inference, and unknown. If an API, version, command, citation, or requirement cannot be confirmed, state the limitation instead of filling the gap based on plausibility.

## Load references

- Read [code-antipatterns.md](references/code-antipatterns.md) for correctness, errors, state, security, integration, and implemented UI.
- Read [testing-antipatterns.md](references/testing-antipatterns.md) when creating, reviewing, or using tests as evidence.
- Read [architecture-antipatterns.md](references/architecture-antipatterns.md) when evaluating abstraction, fragmentation, compatibility, performance, or logging.
- Read [debugging-and-evidence.md](references/debugging-and-evidence.md) when debugging, refactoring, dealing with repeated failures, or building the evidence for a claim.
- Read [review-workflow.md](references/review-workflow.md) for investigation, a localized fix, validation, and reporting.
- Read [sources.md](references/sources.md) when justifying a rule or calibrating quality and correctness claims.
- When the change comes from a design flow, read the brief, the [information architecture](../anti-ai-design/references/information-architecture.md), the [tokens](../anti-ai-design/references/design-tokens.md), and the plan only if they are relevant and current; a draft or merely present file does not authorize implementation.

## Review

1. Map requirements and invariants to concrete execution paths.
2. Prioritize observable failures: incorrect outcome, exception, loss/corruption, authorization, security, race, impossible state, or broken contract.
3. Trace input, transformation, side effects, persistence, and output back to the source of the defective value.
4. Look for false success, swallowed errors, hidden fallbacks, partial mutation, and incomplete rollback.
5. Check concurrency, async, ordering, idempotency, and transactions when applicable.
6. Look for implementations fitted only to known examples or tests, including special-case tables without a domain rule.
7. Formulate one falsifiable hypothesis at a time and choose the smallest experiment that distinguishes it from alternatives.
8. Confirm each finding by file and line, reproduction, test, trace, or contract.
9. Look for disconfirming evidence; when challenged, revalidate from scratch.
10. Reject false positives and label preferences.
11. Apply the removal test: if a helper, wrapper, class, layer, configuration, or comment can disappear without losing a contract, invariant, real reuse, or clarity, prefer the direct form.
12. When there is a plan, validate each task as an observable outcome with origin, strategy, dependencies, definition-of-done criterion, and evidence; reject tasks that merely name an activity.

## Implement only when authorized

- Preserve valid behavior, local architecture, and the public API.
- Prefer a localized fix and minimal change.
- Work in `change → evidence` cycles; do not stack patches when an experiment fails.
- Implement vertical slices by behavior, including only the layers necessary for the same outcome. Do not automatically separate structure, style, interaction, tests, or security into tasks without a consumer.
- Prefer direct control flow, domain-specific names, and one cohesive implementation over fragmentation into trivial helpers.
- Create a regression test when feasible.
- Do not hide an error, relax an assertion, replace a function with a mock, or return false success to make a test pass.
- Do not add a silent fallback or catch-all merely to keep the flow apparently successful; recover only when there are explicit, observable semantics.
- Do not add a framework, layer, dependency, feature flag, README, CI, or configuration outside the scope.
- Do not refactor the entire area to fix a localized defect.
- Do not fill product gaps with invented behavior.
- Do not create an interface, factory, repository, adapter, service, strategy, wrapper, or extensible configuration for a single case without a real boundary.
- Do not add comments or docstrings that merely narrate syntax, promise quality, or repeat the function name.
- Keep temporary diagnostic evidence out of the diff whenever possible. If logs are indispensable, remove them after obtaining the evidence or deliberately turn them into product observability, without secrets or PII.
- Do not compress genuinely complex logic merely to reduce lines; concision means removing structure without value, not hiding behavior.

## Validate

- Run the relevant official commands.
- Before writing a non-trivial test, name which mutation or production defect it must detect and derive the expected outcome independently of the tested implementation.
- For a bug fix, when feasible, observe the regression test fail for the expected cause before the change and pass afterward; record when the previous state cannot be executed.
- Run the reproducing test first, then the suite proportionate to the risk.
- Check lint, typecheck, build, static analysis, or dependency auditing when they exist and are pertinent.
- Review the diff and confirm that pre-existing changes were preserved.
- Map each claim to the appropriate evidence: a test does not replace a build; lint does not replace execution; a green suite does not replace the requirement. Rerun the evidence after the last relevant change.
- In a flow task, use `validated`, `partially validated`, `blocked`, `superseded`, or `failed`; an edit or checked checklist does not mean completion.
- Do not claim success without execution. Report the command, outcome, and everything that could not be tested.

## Output contract

For analysis, deliver findings ordered by impact with file/line, evidence, classification, impact, fix, and validation.

For implementation, deliver the cause, originating task/requirement when applicable, minimal change, changed files, regression test, executed commands, outcomes, task state, limitations, and remaining risks.

Every changed line must be tied to the request or a necessary consequence. Remove only orphaned elements created by the current change; pre-existing technical debt must be reported, not silently absorbed.

Never detect, attribute, or speculate about authorship or provenance. Use only observable classifications such as “confirmed defect,” “code smell,” “generic pattern,” “inconsistency,” or “insufficient evidence.”
