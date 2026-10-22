# Validation checklist

## General

- [ ] Eligibility was revalidated against the current state.
- [ ] Git was detected before querying branch, HEAD, or status; outside Git, an inventory and hashes of the relevant files were used.
- [ ] When Git exists, HEAD and status were rechecked; in all cases, the files were rechecked before editing.
- [ ] The problem was reproduced beforehand.
- [ ] The cause matches the approved finding.
- [ ] The change is within scope.
- [ ] Pre-existing changes were preserved.
- [ ] The public API and valid behavior were preserved.
- [ ] The regression test fails before and passes after, when feasible.
- [ ] The regression would fail again without the fixed control.
- [ ] A legitimate positive use still works.
- [ ] Pertinent siblings, aliases, and bypasses were checked.
- [ ] The focused test passed.
- [ ] The suite proportionate to the risk passed.
- [ ] Pertinent lint/typecheck/build passed.
- [ ] The diff contains only intentional changes.
- [ ] The rollback strategy is documented and compatible with pre-existing changes.
- [ ] Rollback was rehearsed in a safe environment when the risk justified it; impossibility and residual risk were stated.
- [ ] The evidence was rerun after the last relevant change.
- [ ] The task state derives from the evidence and IDs; written code was not automatically marked as validated.
- [ ] No error was hidden.
- [ ] No mock replaces functionality.
- [ ] No unnecessary dependency/framework/configuration was added.

## Data and operations

- [ ] Input validation and invariants.
- [ ] Authorization at the correct boundary.
- [ ] Transaction and rollback on partial failure.
- [ ] Retry and idempotency.
- [ ] Concurrency, await, cancellation, and timeout.
- [ ] Observable terminal state and error.
- [ ] No secrets/PII in code or logs.

## UI

Select only checks applicable to the widget, risk, platform, change, and
available evidence; mark the rest as `not applicable` or `not exercised`
with a reason, without claiming coverage.

- [ ] Before/after screenshot with the same data and viewport when a comparable visual runtime exists.
- [ ] Viewports pertinent to the changed responsive surfaces.
- [ ] Affected real content and states.
- [ ] Keyboard, focus, Escape, and focus return for the corresponding widgets.
- [ ] Affected semantics, labels, and messages.
- [ ] Contrast, non-exclusive use of color, and targets when styles or interaction change.
- [ ] Reflow, zoom, text spacing, and long strings when layout/content may be affected.
- [ ] Reduced motion when motion exists or changes.
- [ ] Broad change received human approval.
- [ ] Navigation/URL changes preserve applicable direct links, refresh, back/forward, return, and compatibility.
- [ ] Token changes originated from the authoritative source, officially regenerated outputs, and covered affected consumers, modes, and states.
- [ ] Code, evidence, task status, and directly affected authorized artifacts do not contradict each other; out-of-scope pending work was recorded without editing.

## Handoff

- [ ] Each ID has an independent final status.
- [ ] Commands and exit codes were recorded.
- [ ] Limitations were stated.
- [ ] Remaining risk was stated.
- [ ] Git was rechecked when applicable.
- [ ] No unauthorized stage, commit, or push.
