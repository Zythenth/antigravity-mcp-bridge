---
name: anti-ai-audit
description: "Audit interfaces, accessibility, responsiveness, code, architecture, tests, documentation, states, and actual behavior in strictly read-only mode. Use only when explicitly invoked with a repository, path, diff, screenshots, or running interface; hand off approved findings to anti-ai-remediate instead of fixing them. Read project evidence and produce findings by severity with false positives rejected."
---

# Anti-AI Audit

Conduct an audit without detecting or attributing authorship. Evaluate defects, vulnerabilities, accessibility, maintainability, generic patterns, and inconsistencies solely through observable evidence.

## Remain strictly read-only

Do not edit, format, install, remove, create permanent files, stage, commit, or push. Do not run commands that generate caches, snapshots, lockfiles, databases, artifacts, or migrations in the project. Diagnostics that need to write must use a temporary directory outside the target and must not alter external state. If the user requests fixes, complete the report and hand off the approved IDs to `$anti-ai-remediate`; this skill never applies changes.

## Prepare

1. Resolve the target type — repository, path, diff, commit, branch, worktree, screenshot, or app — and establish the baseline.
2. Read instructions, README, specification, design system, code, tests, configs, and relevant history.
3. When the target is in Git, record the root, branch, HEAD, status, and pre-existing changes without modifying them. For a branch or PR, identify the documented upstream or target and calculate the `merge-base` with HEAD; do not assume `main`, `HEAD^`, or the previous commit. Record the command and SHA used as the baseline. Outside Git, mark these fields as not applicable.
4. In a diff review, compare `merge-base..HEAD` or the explicitly requested range and separate what was introduced or worsened from pre-existing technical debt.
5. Identify users, tasks, data, states, invariants, and surfaces.
6. When a brief, information architecture, tokens, plan, or checkpoint is within scope, verify its status, authority, and whether it is current before treating it as a source. A present file does not mean completed, and an artifact does not automatically override code or a later decision.
7. For UI, directly load [design principles](../anti-ai-design/references/design-principles.md), [information architecture](../anti-ai-design/references/information-architecture.md), [design tokens](../anti-ai-design/references/design-tokens.md), [visual antipatterns](../anti-ai-design/references/design-antipatterns.md), and [accessibility](../anti-ai-design/references/accessibility-baseline.md).
8. For code, directly load [code antipatterns](../anti-ai-code/references/code-antipatterns.md), [testing](../anti-ai-code/references/testing-antipatterns.md), and [architecture](../anti-ai-code/references/architecture-antipatterns.md).
9. For security, directly load the [security checklist](../anti-ai-security/references/security-checklist.md) and [validation and severity](../anti-ai-security/references/validation-and-severity.md), keeping this audit free of edits.

## Audit

- Use [audit-checklist.md](references/audit-checklist.md) for coverage.
- Use [severity-model.md](references/severity-model.md) for impact and confidence.
- Use [report-template.md](references/report-template.md) for the report.
- Run the application and capture actual evidence only when this can be done in read-only mode.
- Cite a file/line, component, screenshot, viewport, command, or trace.
- Maintain a candidate ledger; close each item as confirmed, suppressed, not applicable, infrastructure-dependent, unverified, or duplicate.
- Validate candidates, look for the evidence that would defeat them, and reject false positives.
- Separate a product problem from an aesthetic/code preference.
- Continue auditing the entire planned scope after the first finding. One confirmed problem does not conclude families, files, flows, or surfaces that have not yet been examined; explicitly record any coverage cutoff.
- When a product, infrastructure, or baseline question remains material, record the source researched, recommendation, effect on severity/confidence, and independent work completed. Block only the dependent family or surface.
- For UI, declare the evidence profile and coverage by surface/route, state, viewport, and theme/input. Do not present a supplied screenshot or isolated code as complete runtime validation.

## Finding rules

Each finding must include:

- ID and title;
- area;
- severity and confidence;
- file, line, or component;
- affected control or root cause;
- actor and preconditions;
- evidence;
- strongest disconfirming evidence examined;
- evidence gap;
- impact;
- severity rationale;
- violated rule;
- finding classification;
- recommended fix;
- fix risk;
- required validation;
- acceptance criteria.

Separate severity, confidence, and remediation priority. Deduplicate only when the control/cause, behavior, impact, and fix are the same; preserve every location.

Do not detect, attribute, or speculate about authorship or provenance. Use only observable classifications such as “generic pattern,” “decision without functional justification,” “code smell,” “inconsistency,” “confirmed defect,” or “insufficient evidence.”

## Conclude

Sort by severity and dependency. Separate confirmed findings, pending decisions, preferences, rejected false positives, and pre-existing technical debt. Report coverage, the closure matrix, commands with exit codes, limitations, unaudited areas, and residual risk. If nothing qualifies, state explicitly: **No qualifying findings**.
