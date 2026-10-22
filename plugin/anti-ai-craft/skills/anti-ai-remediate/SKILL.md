---
name: anti-ai-remediate
description: "Apply only confirmed audit findings that are approved by the user, reproducible, and within the current scope. Use only when explicitly invoked with IDs or an approved report and authorization to edit; do not use for open-ended review, speculative cleanup, or unapproved fixes. Read the target state and, when Git exists, the branch/HEAD/status; implement minimal fixes, run regressions, and report the outcome for each finding."
---

# Anti-AI Remediation

Fix only findings that are confirmed, approved, reproducible, and within scope. Do not turn remediation into general refactoring.

## Require sufficient input

Obtain:

- report or findings with IDs;
- subset approved by the user;
- file/behavior scope;
- authorization to edit;
- acceptance criteria and expected validations.

If there is no reproducible finding or fix scope, do not activate changes. Route the investigation to audit/analysis.

Accept IDs from audit, security, or design review only when they preserve evidence, classification, and acceptance. For visual IDs, also require the feature/phase, current artifact, and applicable state/viewport/theme; if a field does not apply, record the reason. A brief, plan, or checklist — even if approved — does not replace IDs or authorization to edit.

## Prepare

1. Detect whether the target belongs to a Git repository. Only then record the branch, HEAD, status, staged, and untracked state; outside Git, record an inventory and hashes of the relevant files without running Git commands.
2. Preserve pre-existing changes.
3. Read the approved report and evidence.
4. Load [remediation-protocol.md](references/remediation-protocol.md).
5. Load [validation-checklist.md](references/validation-checklist.md) and use it before handoff.
6. Load [approval-gates.md](references/approval-gates.md) for limits.
7. For code, load the [review workflow](../anti-ai-code/references/review-workflow.md) and [testing](../anti-ai-code/references/testing-antipatterns.md).
8. For UI, load the [visual workflow](../anti-ai-design/references/review-workflow.md), [accessibility](../anti-ai-design/references/accessibility-baseline.md), and [direction contract](../anti-ai-design/references/direction-contract.md).
9. For security, load the [remediation workflow](../anti-ai-security/references/remediation-workflow.md) and [validation and severity](../anti-ai-security/references/validation-and-severity.md).
10. Before requesting information, look in the report, current state, code, tests, artifacts, and pertinent history. For a decision that remains material, report the recommendation, risk, and preserved behavior; block only dependent IDs and continue with independent approved IDs.

## Fix

1. **Eligibility gate, still read-only:** revalidate the current state, reproduction, reachability, invariant, and scope. Classify as ready, already fixed/no change, blocked on evidence, blocked on product, or out of scope.
2. **Plan gate, still without editing:** map IDs, cause, boundary, files, behavior that changes and remains, regression/positive validation, risk, and rollback.
3. **Application gate:** when Git exists, revalidate HEAD and status; always revalidate the files. Fix one logical cause at a time and map any grouping of IDs.
4. **Frozen verification gate:** prove that the original case no longer reproduces, legitimate use works, the regression is sensitive to the control, siblings/bypasses were checked, and the diff/commands cover only what was intended.
5. For UI, run and capture before/after with the same data, states, and viewports.
6. When there is a design plan, represent each batch as a slice linked to the IDs and maintain an independent final status; a task list does not grant new authorization.
7. Update the brief, architecture, tokens, or plan only when this is within the approved ID or is a stated necessary consequence. Without authorization, record the documentation as pending.
8. If validation fails, mark the failure and return to the plan; do not stack patches.
9. Request new approval when the plan, risk, behavior, or scope changes materially.

## Limits

Do not:

- refactor the entire architecture;
- modify independent areas;
- invent a requirement;
- hide a failure;
- reduce coverage;
- update all dependencies;
- introduce a framework;
- create a generic layer without need;
- replace functionality with a mock;
- claim a fix without reproduction;
- automatically approve a visual outcome;
- erase existing work;
- commit or push without explicit authorization.

## Output

For each finding, report the status: fixed and validated, fixed with partial validation, not reproduced, already fixed/no change, blocked on evidence, blocked on product, blocked by scope, failed validation, or rejected. Include the cause, change, files, regression, commands/outcomes, relevant diff, remaining risk, and required approval.
