# Testing antipatterns

## Summary

- [Test as evidence](#test-as-evidence)
- [False confidence](#false-confidence)
- [Mocks](#mocks)
- [Waits](#waits)
- [Snapshots](#snapshots)
- [Required cases](#required-cases)
- [Oracle quality](#oracle-quality)
- [Honest execution](#honest-execution)

## Test as evidence

A passing test demonstrates only the cases and oracles it contains. It does not demonstrate general correctness, security, performance, absence of races, or compliance.

Prefer a test that:

- fails before the fix for the expected cause;
- passes afterward;
- exercises the real API/behavior;
- verifies the effect and persisted state;
- covers a boundary or failure path;
- remains deterministic;
- explains the regression.

Before writing the body, name the mutation or production defect that the test must detect. Derive the expected outcome from a contract, domain rule, or independent calculation; do not reuse a helper/builder/algorithm from the unit as the oracle.

For a bug fix, prefer this sequence:

1. write or locate a test that reproduces the bug;
2. run it against the defective behavior and confirm that it fails for the expected cause;
3. apply the minimal fix;
4. confirm that the test passes;
5. run regression coverage proportionate to the risk.

If the previous state cannot be executed safely or has already changed, record that limitation instead of simulating a red step.

## False confidence

- happy-path-only suite;
- weak or absent assertions, or assertions on constant values;
- test that only confirms the mock returned the configured value;
- mocking the unit under test;
- stub so detailed that it reimplements production;
- large snapshot approved without semantic review;
- test that passes even when the logic is removed;
- high coverage without branches, boundaries, or mutation score;
- fixture incompatible with real data;
- selective execution that ignores failures;
- automatic retry that masks flakiness;
- skipped/xfail test without a deadline and reason;
- test generated alongside the bug that encodes the incorrect behavior.
- implementation or fixture encoded as a response table to satisfy only the known examples.

## Mocks

- Know which side effects belong to the contract before mocking.
- Mock a slow, unstable, or external boundary when necessary.
- Mock the lowest boundary possible and preserve required real effects.
- Do not mock a type/contract that is not understood.
- Verify the observable outcome before the internal call sequence.
- Use a fake/in-memory implementation only if it preserves relevant semantics.
- Keep at least one integration test for wiring, serialization, transaction, authentication, and configuration.
- Do not replace a real dependency with a mock in production to “fix” a test.
- Mock call expectations are not primary evidence when an observable outcome exists.

## Waits

- Prefer an observable event or condition with a diagnostic timeout over an arbitrary `sleep`.
- Use a fixed delay only when time is an explicit part of the contract.
- When the timeout expires, record the observed state to distinguish slowness, deadlock, and a missing event.

## Snapshots

- Use for a stable representation that a person can review.
- Avoid huge or volatile snapshots, or snapshots with IDs/timestamps.
- Do not update snapshots in bulk without explaining the change.
- Add semantic assertions for critical properties.
- In UI, do not treat a DOM snapshot as a substitute for interaction, accessibility, and a real screenshot.

## Required cases

Select according to the contract:

- zero, one, many, minimum, maximum, and out of range;
- empty, null/missing, invalid, and wrong type;
- duplication, different order, and long data;
- denied permission, another user/tenant, and expired session;
- timeout, unavailability, and partial failure;
- retry, idempotency, and rollback;
- concurrency/interleaving;
- encoding, locale, timezone, and DST when pertinent;
- real API/dependency/config;
- historical regression.

## Oracle quality

- Verify the response, side effects, persistence, event, and log only to the extent required by the contract.
- Do not assert only that it “did not throw an exception.”
- Do not use the implementation as its own oracle.
- Add inputs absent from the original examples when there is a risk that the implementation was fitted to the tests.
- Prefer a property/invariant when isolated examples are insufficient.
- Use mutation testing, fuzzing/property tests, or expanded cases in proportion to the risk; do not require them as a ritual.

## Honest execution

- Record the exact command, exit code, and relevant summary.
- Distinguish “not run,” “unavailable,” “failed due to environment,” and “passed.”
- Do not claim lint/build/typecheck/test results without running them.
- Do not hide stderr, remove a test, loosen an assertion, or change a fixture to eliminate a failure without identifying the cause.
- Run the focused test and then a larger suite proportionate to the impact.
