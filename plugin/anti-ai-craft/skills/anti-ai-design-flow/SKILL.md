---
name: anti-ai-design-flow
description: "Orchestrate a complete, resumable product journey, from briefing through information architecture, visual system, build plan, authorized implementation, review, and finding handoff. Use only when explicitly invoked to conduct three or more phases, coordinate two or more Anti-AI skills, start a feature from scratch, or resume a persisted flow; do not use for an isolated component, a local visual fix, or standalone audit, code, or threat-model work."
---

# Anti-AI Design Flow

Orchestrate phases and handoffs without replacing specialized contracts. Treat the flow as an adaptive state machine, not as a linear ritual. Planning does not authorize editing; authorization does not silently carry across phases, skills, or external actions.

## Prepare the flow

1. Confirm the feature, objective, scope, definition of success, and whether the user wants only planning or also implementation and review.
2. Read instructions, README files, specifications, the design system, code, tests, configurations, assets, and relevant history before asking questions.
3. Locate existing planning conventions. Do not create `.design/` or another directory if the project already defines a source of truth.
4. Read [flow-state.md](references/flow-state.md) in full and create the execution record.
5. Classify each phase as `execute`, `reuse`, `update`, or `not applicable`, citing the evidence. An existing file does not prove that a phase is complete.
6. Resolve verifiable facts in the project first. For any material decision that remains open, ask in a short round with a recommendation, rationale, consequence, and work that can continue.
7. Request separate authorization before creating or updating persistent artifacts. Without authorization, keep the checkpoint in the response and state that resumption across tasks depends on that record.

## Consult specialized contracts

The sibling files are internal references for this flow; reading them does not activate another
skill and must not be described as though that skill had been invoked. Read only the
contract applicable to the phase:

- `../anti-ai-design/SKILL.md` for briefing, structure, tokens, direction, accessibility, and visual review;
- `../anti-ai-security/SKILL.md` when data, identity, roles, tenants, cost, integration, upload, automation, or a protected operation changes;
- `../anti-ai-code/SKILL.md` for scoped implementation and per-task evidence;
- `../anti-ai-audit/SKILL.md` for an independent, strictly read-only review;
- `../anti-ai-remediate/SKILL.md` only to prepare the handoff of confirmed and approved IDs.

When a phase requires another skill's own mode or authority—independent audit,
a complete threat model, or remediation—provide the necessary input
and request its explicit invocation. Do not activate, simulate, or claim that another skill
was executed. Do not copy condensed versions of those contracts into this skill.

## Execute adaptive phases

### 1. Discovery and brief

- Build a ledger of material decisions.
- Identify the problem, users, task, context, surface, mandate, requirements, invariants, content, data, states, risks, out-of-scope items, and acceptance criteria.
- Use the `anti-ai-design` brief contract as an internal reference.
- Mark the output as `draft`, `blocked`, or `approved`; only explicit user confirmation permits `approved`.

**Ready when:** the decisions required for the next phase are confirmed, assumed with low risk, or blocked with a precise condition; no material requirement was invented.

### 2. Information architecture

- Execute when there are multiple surfaces, navigation, routes, growing content, roles, resumption, or a multi-step flow.
- Map entry points, tasks, hierarchy, navigation, URLs, persistence, the primary flow, alternatives, errors, and recovery.
- Cross-check UI, data, and authorization. Do not treat hidden navigation as a security control.

**Ready when:** in-scope surfaces and flows have entry, exit, states, a location contract, and verifiable criteria; material compatibility is preserved or approved.

### 3. Visual system and tokens

- Reuse the project's authoritative source.
- Distinguish the source from generated outputs, resolve aliases, and map consumers.
- Create or extend only the families required by the scope.
- Do not require dark mode, a stack, scale, breakpoint, or format.

**Ready when:** semantic roles and real consumers are identified, applicable modes and states are covered, and any migration has a bounded reach.

### 4. Build plan

- Decompose work into vertical slices by observable outcome, not by HTML/CSS/JS, file, or discipline.
- Record origin, outcome, the `reuse/change/create` strategy, dependencies, risk, definition-of-done criterion, and evidence.
- Distinguish hard blockers, preferred order, and safe parallelism.
- Anticipate hard dependencies, the highest-risk hypothesis, and a representative first slice.

**Ready when:** every task is tied to a requirement, decision, or risk; there is no infrastructure without a consumer and no material decision hidden in a subtask.

### 5. Security gate

Execute only when there is an applicable surface. Record assets, actors, data, boundaries, tenants, expensive or destructive operations, expected controls, and abuse stories. Classify each item as `resolved`, `decision pending`, `depends on infrastructure`, or `not applicable`.

**Ready when:** decisions that would change the structure or completion criteria are resolved or blocked before the build.

### 6. Authorized implementation

- Confirm editing authorization and task scope.
- Implement one slice at a time according to the internal `anti-ai-code` contract, without claiming that the skill was invoked.
- Map task → files → change → evidence.
- Do not mark a task complete merely because it was edited; use `validated`, `partially validated`, `blocked`, `superseded`, or `failed`.
- Revalidate only dependent artifacts when new evidence changes an earlier decision.

**Ready when:** the slice's criteria were exercised after the latest change, legitimate use remained functional, and the diff stayed limited to the outcome.

### 7. Independent review

- Execute only when there is evidence proportionate to the type of review.
- Apply the internal visual/technical review contract. When a broad independent audit is required, prepare the scope and request explicit invocation of `$anti-ai-audit`.
- Compare the task, brief, structure, tokens, plan, code, and runtime without assuming that a document or the code is automatically the current source.
- Produce stable IDs; separate severity, confidence, priority, gate, preferences, and false positives.

**Ready when:** coverage, evidence, limitations, preserved decisions, and residual risk are explicit. Review does not authorize remediation.

### 8. Optional remediation

- Accept only explicitly selected IDs.
- Revalidate each finding against the current state.
- Prepare a handoff to `$anti-ai-remediate`; apply fixes only after that skill is explicitly invoked with the IDs and authorization.
- Update flow artifacts only when authorized and required by the ID.

**Ready when:** every ID has a status and evidence; code, evidence, the task, and authorized artifacts do not contradict one another.

## Transition and invalidate

- Advance through read-only phases when the output is sufficient and no material decision remains open.
- Request confirmation for changes to identity, navigation, contract, scope, risk, editing, external action, or product trade-off.
- Do not request ritual confirmation after every question, phase, or task.
- If an earlier decision changes, mark only dependents as `revalidate`; do not rewrite the entire flow.
- If the user pauses, emit a checkpoint with the phase, outputs, decisions, blockers, files, and next safe action.
- If there are multiple features, require an unambiguous identifier; do not silently choose based on modification date.

## Boundaries

Do not:

- implicitly activate or replace `$anti-ai-design`;
- impose a fixed set of documents on a small task;
- inherit authorization for commit, push, deploy, rotation, migration, or production;
- move fixes into the audit;
- treat an existing file, a checked checklist, or a green build as sufficient evidence;
- choose a theme, aesthetic, stack, library, or breakpoint from a preset;
- overwrite an existing artifact or persist secrets and personal data;
- treat a visual preference as a defect or vulnerability;
- continue a blocked phase by inventing product details, data, APIs, or behavior.

## Output contract

Deliver:

- feature and objective;
- current phase and classification of all phases;
- sources of truth and code state used;
- decisions, assumptions, blockers, and invalidations;
- artifacts produced or updated and the corresponding authorization;
- tasks and evidence by state;
- review or remediation IDs, when applicable;
- validations executed and not executed;
- residual risk;
- checkpoint and next safe action.
