# Remediation protocol

## 1. Initial state

- Resolve the project root and instructions.
- First detect whether the target belongs to a Git repository.
- When Git exists, record the branch, HEAD, status, staged, and untracked state using read-only commands.
- Outside Git, record the inventory, metadata, and hashes of the relevant files; do not run Git commands or treat their absence as a failure.
- Use read-only status, diff, and hashes to prove preservation. Do not duplicate user files as evidence.
- Do not clean, reset, stash, or overwrite pre-existing changes.

## 2. Eligibility gate — read-only only

- List approved IDs.
- Confirm severity, evidence, files, and dependencies.
- Revalidate the current state, reachability, and invariant before planning a change.
- Classify each ID as ready, already fixed/no change, blocked on evidence, blocked on product, or out of scope.
- Order by cause and dependency to avoid duplicate fixes.

## 3. Plan gate — still without editing

- Run the original case.
- Record the outcome before the change.
- Build a minimal test when none exists.
- Confirm that it fails because of the described cause, not the environment.
- For UI, capture the previous state/viewport.
- Map the cause, boundary, files, behavior that changes and remains, regression, positive validation, risk, and rollback.
- Group IDs only when their relationship to the same cause and change is explicit.
- For a persisted flow, represent the batch by outcome, origin, dependencies, definition-of-done criterion, and evidence; the plan does not expand the list of authorized IDs.

## 4. Application gate

- Trace input, state, side effects, and output.
- Identify the first invariant violation.
- When Git exists, revalidate HEAD and status; always revalidate file contents immediately before editing.
- Prefer a fix at the correct boundary.
- Preserve the public API and architecture.
- Avoid a generic abstraction/flag/configuration.
- Document the trade-off if more than one fix is valid.

## 5. Implementation

- Edit only necessary files.
- Preserve style and conventions.
- Do not swallow an exception, return false success, or relax validation.
- Ensure transaction, rollback, idempotency, and concurrency as applicable.
- For UI, preserve identity and implement complete behavior/accessibility.
- Fix one logical cause at a time and obtain evidence before the next.
- For navigation or a public URL, preserve deep links, refresh, back/forward, return, and compatibility, or implement an approved migration/redirect.
- For tokens, edit the authoritative source, regenerate outputs with the official command, and validate affected consumers, modes, and states; do not replace values in bulk without a usage map.

## 6. Frozen verification gate

- Demonstrate the failure before the change when feasible.
- Demonstrate success afterward.
- Cover a related boundary/failure case.
- Avoid a mock that confirms itself.
- Do not re-record a snapshot without review.
- Confirm that the test fails if the fixed control is removed.
- Check related siblings, aliases, and bypasses.
- If it fails, mark the ID as failed validation and return to the plan; do not stack patches.

## 7. Validation

- Run the focused test.
- Run the suite proportionate to the risk.
- Run pertinent lint/typecheck/build/analysis.
- Review the diff.
- Rerun the reproduction.
- For UI, capture the after state and compare it.
- Confirm that the rollback strategy is documented and, when the risk justifies it, rehearsed in a safe environment or through a dry run before handoff.
- When there is a design flow, reconcile code, evidence, task status, and directly affected artifacts. Update a document only with authorization.

## 8. Handoff

- Map files to findings.
- Provide exact commands and outcomes.
- Report validation that was not run.
- List remaining risk.
- Confirm Git state when applicable and the absence of commit/push.
- Report status by ID, including no-change items and blockers.

## Rollback

- Revert only hunks created in this remediation; never use reset, checkout, or stash to erase someone else's work.
- For data/migrations, define the backup, compatibility, and reversal strategy before the change.
- Rehearse restoration, down migration, feature rollback, or an equivalent procedure in a safe environment when reversal failure could cause loss, unavailability, or material inconsistency. If rehearsal is not possible, state the gap before applying the change.
- State irreversibility before acting and require specific authorization.
