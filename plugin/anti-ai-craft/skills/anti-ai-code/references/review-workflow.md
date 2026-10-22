# Review and implementation workflow

## Summary

- [Permanent gates](#permanent-gates)
- [Resolve scope](#1-resolve-scope)
- [Build a system model](#2-build-a-system-model)
- [Plan verifiable tasks](#21-plan-verifiable-tasks-when-necessary)
- [Discover candidates](#3-discover-candidates)
- [Validate candidate](#4-validate-candidate)
- [Fix](#5-fix)
- [Validate](#6-validate)
- [Report](#7-report)

## Permanent gates

1. **Understand before acting:** read the system, trace the path, and resolve material ambiguities.
2. **Preserve the scope:** do not turn the task into general cleanup or architectural expansion.
3. **Require evidence before claiming:** run the verification, read the output, and separate fact, inference, and unknown.

## 1. Resolve scope

- Confirm analysis versus editing.
- Identify files, behavior, requirements, and risk.
- Read instructions and sources of truth.
- When there are material decisions, record origin, dependencies, recommendation, and impact. Resolve contract/invariant before boundary/API and implementation; do not create a ledger for an unambiguous fix.
- Record branch, HEAD, status, and pre-existing changes when Git is present.
- Define success criteria and, for risky changes, a reversal strategy before editing.

## 2. Build a system model

- Map inputs, outputs, side effects, persistence, and boundaries.
- Identify invariants, states, and the public API.
- Locate the implementation, callers, tests, config, dependencies, and relevant history.
- Do not review a snippet as a complete system when context exists.
- When there is a relevant brief, architecture, tokens, or plan, verify its state, authority, and currency against the code. A draft or superseded document is not a current requirement.
- In a routed frontend, map direct entry, URL/history, loader or data source, cache, persistence, error, and return as appropriate to the platform.

## 2.1 Plan verifiable tasks when necessary

For a non-trivial change or persisted flow, record only:

- observable outcome;
- originating requirement, decision, finding, or risk;
- `reuse`, `change`, or `create` strategy;
- likely scope, without inventing files;
- hard blockers, preferred order, and safe parallelism;
- applicable states, accessibility, and security;
- definition-of-done criterion and evidence.

Order by real dependencies, risk of late discovery, and a representative first slice. Do not automatically prioritize foundation work. Update the plan when new evidence emerges, recording a split, blockage, replacement, or rejection; do not silently rewrite a task that is already validated.

## 3. Discover candidates

Look in this order:

1. reproducible functional failure;
2. loss/corruption and false success;
3. authorization and vulnerability;
4. transaction, concurrency, and async;
5. invented contract/API/dependency;
6. test that does not detect a regression;
7. smell with maintenance impact;
8. subjective preference.

## 4. Validate candidate

For each candidate:

- locate the file/line;
- describe the execution path;
- reproduce it or build a minimal test;
- confirm the requirement/invariant;
- check whether a protection already exists;
- look for false positives and reachability conditions;
- calibrate impact and confidence.

Do not report a grep result without an executable path as a confirmed bug.

## 5. Fix

When authorized:

1. preserve pre-existing work;
2. write/reproduce the regression test and, when feasible, observe the expected failure before the fix;
3. identify the cause, not only the symptom;
4. apply the smallest coherent change;
5. preserve the public API and local patterns;
6. do not hide the failure;
7. do not expand the architecture;
8. update documentation only if the contract actually changed.
9. keep temporary diagnostic evidence until the fix is confirmed; then remove it or deliberately normalize it.
10. in a design plan, map task → files → change → evidence and stop only the item whose current source contradicts the code.

## 6. Validate

- Run the focused test before/after.
- Run a suite proportionate to the risk.
- Run pertinent lint/typecheck/build/static analysis.
- Verify real dependencies/config/APIs.
- For persistence: test partial failure, rollback, and retry.
- For concurrency: test ordering, cancellation, timeout, and duplication.
- Review the diff and unintended files.
- For a route or navigable state, test direct link, refresh, back/forward, and restoration when they are part of the contract.
- Mark a task `validated` only after running the evidence following the latest change; use `partially validated`, `blocked`, `superseded`, or `failed` in the other cases.

## 7. Report

Each finding includes:

- title and classification;
- file/line;
- evidence/reproduction;
- impact;
- violated rule/contract;
- suggested fix;
- risk of the fix;
- required validation.

Each fix includes:

- cause;
- changed files;
- minimal change;
- regression;
- commands/outcomes;
- validation not performed;
- remaining risk.

When there is a persisted plan, reconcile task states with the diff and validations. Update the document only when authorized; otherwise, record the pending work.
