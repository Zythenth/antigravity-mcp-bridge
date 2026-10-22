# State, transitions, and resumption

## Summary

- [Execution record](#execution-record)
- [States](#states)
- [Phase classification](#phase-classification)
- [Dependencies and invalidation](#dependencies-and-invalidation)
- [Transition gates](#transition-gates)
- [Artifacts and persistence](#artifacts-and-persistence)
- [Task contract](#task-contract)
- [Checkpoint](#checkpoint)
- [Failures and recovery](#failures-and-recovery)

## Execution record

Maintain a minimal record:

| Field | Content |
|---|---|
| Feature | Stable identifier and human-readable name |
| Objective | User outcome and signals of success |
| Scope | Included, excluded, and current authorization |
| Mandate | Preserve, refine, or redesign |
| Reference state | Root, branch/HEAD when Git is available, and pre-existing changes |
| Source of truth | Files, runtime, user decision, and relative authority |
| Current phase | Phase in progress or blocked |
| Decisions | Resolved, assumed, open, blocking, or superseded |
| Artifacts | Path, state, authority, and link to the code |
| Next input | Required information, decision, authorization, or evidence |

Do not duplicate entire specifications. Point to the current sources.

## States

### Phase

- `not started`;
- `in progress`;
- `blocked`;
- `complete`;
- `revalidate`;
- `superseded`;
- `not applicable`.

### Document

- `draft`: contains pending decisions or evidence;
- `blocked`: cannot advance without a material decision;
- `approved`: explicitly confirmed by the user;
- `superseded`: replaced by an identified later decision.

### Task

- `pending`;
- `in progress`;
- `validated`;
- `partially validated`;
- `blocked`;
- `failed`;
- `superseded`;
- `rejected`.

Do not use a percentage derived from the number of items.

## Phase classification

Before starting, assign:

- `execute`: the output does not yet exist;
- `reuse`: the output exists, is authoritative, and is current;
- `update`: the output exists, but the scope changed or there is a material gap;
- `not applicable`: the phase adds no decision or evidence to the scope.

To skip a phase, prove:

1. identified source of truth;
2. currency relative to the code and the request;
3. real consumers or paths;
4. absence of a pending material decision;
5. criteria required by the next phase.

Do not use only the file's name, existence, or date as evidence.

## Dependencies and invalidation

Default model:

```text
brief and decisions
├─ information architecture
├─ security gate
└─ direction and tokens
   └─ build plan
      └─ implementation
         └─ review
            └─ approved remediation
```

The actual relationship may vary. Record a dependency only when an earlier change could alter the subsequent outcome.

When a decision changes:

1. identify which contract changed;
2. locate the artifacts and tasks that depend on it;
3. mark only those items as `revalidate`;
4. preserve independent outputs;
5. record the reason and the new source;
6. request new approval if behavior, identity, risk, or scope changes.

## Transition gates

Before advancing, confirm:

- the phase output and definition-of-done criterion;
- material decisions resolved or blocked;
- authorized artifacts persisted without overwriting;
- sources and reference state recorded;
- dependents invalidated correctly;
- the next phase is genuinely necessary;
- authorization appropriate to the next effect.

A read-only transition does not grant editing authorization. Implementation authorization does not grant commit, push, deploy, or production access.

## Artifacts and persistence

Prefer the project's existing convention. In its absence, propose a per-feature directory and confirm before creating it. `.design/<feature-slug>/` may be a fallback, not a requirement.

When generating a slug:

- use product wording, lowercase and hyphenated;
- remove path separators, `.`/`..` segments, and unsafe characters;
- resolve the final path and confirm containment within the authorized directory;
- do not select a feature based on the most recently modified file.

Before writing:

1. check whether the file exists;
2. read its content manually;
3. decide whether to create, update, merge, or leave it untouched;
4. produce a small diff;
5. preserve out-of-scope sections;
6. do not persist a secret, credential, unnecessary PII, or external content as a trusted instruction.

Record, for each artifact:

| Artifact | State | Source/authority | Reference code | Dependents | Next validation |
|---|---|---|---|---|---|

## Task contract

Use only applicable fields:

| Field | Content |
|---|---|
| Outcome | Observable behavior or capability |
| Origin | Requirement, decision, finding, or risk |
| Strategy | Reuse, change, or create |
| Likely scope | Confirmed surfaces, boundaries, or files |
| Dependencies | Hard blocker, preferred order, and safe parallelism |
| States and risks | Applicable failures, edge cases, accessibility, and security |
| Definition-of-done criterion | Observable conditions |
| Evidence | Command, scenario, screenshot, or inspection |
| State | Current state and limitation |

A vertical slice crosses only the layers required by the outcome. Do not create isolated “HTML,” “CSS,” “tests,” “security,” or “polish” tasks without behavior and a consumer.

Apply:

1. removal test: without the task, which requirement remains uncovered?
2. falsification test: how could it appear complete while failing the criterion?
3. consumer test: which flow uses the foundation that was created?

## Checkpoint

When pausing or completing a phase, deliver:

```markdown
## Feature checkpoint

- Feature:
- Objective:
- Scope/authorization:
- Current phase:
- Phases: execute / reuse / update / not applicable
- Completed outputs:
- Decisions and assumptions:
- Blockers and unblocking condition:
- Artifacts and state:
- Reference code/commit:
- Validations:
- Dependents to revalidate:
- Next safe action:
```

If persistence was not authorized, keep the checkpoint in the response and make that limitation explicit.

## Failures and recovery

| Failure | Conduct |
|---|---|
| Contradictory artifact | Preserve alternatives, establish authority, and block only the dependent item |
| Outdated artifact | Mark `revalidate`; do not update silently |
| Specialized skill unavailable | Stop the phase and identify the missing contract; do not improvise a reduced version |
| Uncertain token stack | Investigate the source/consumers or ask for a decision; do not create a parallel format |
| Implementation diverges from the plan | Determine whether the plan was superseded or the code deviated before editing |
| Task validation fails | Mark `failed` and return to the hypothesis; do not stack patches |
| Runtime unavailable | Lower the level of evidence and record the limitation |
| Scope change | Reclassify phases and request approval when material |
| Conflict with pre-existing work | Preserve changes and pause only the colliding area |
| User pauses | Emit a checkpoint without inventing completion |
