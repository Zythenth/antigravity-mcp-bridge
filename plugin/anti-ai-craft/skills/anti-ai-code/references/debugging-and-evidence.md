# Debugging and evidence

## Investigation cycle

1. Read the complete error and stack.
2. Reproduce it with the smallest faithful case.
3. Check recent changes and a neighboring path that works.
4. Trace the incorrect value back to its source across boundaries.
5. Formulate **one** falsifiable hypothesis.
6. Run the smallest experiment that separates that hypothesis from the alternatives.
7. If it fails, isolate or undo the experiment before the next one. Repeated failures require revisiting the mental model, not automatically declaring that the entire architecture is wrong.

Avoid successive patches without new evidence, simultaneous changes that prevent attributing the cause, and explanations after the fact.

## Change and evidence

Every non-trivial step must form a pair:

- observable change;
- specific evidence gathered after it.

Lock the claim before choosing the command. Examples:

| Claim | Minimum adequate evidence |
|---|---|
| bug fixed | original reproduction no longer fails and regression passes |
| API compatible | type/signature for the exact version and execution or build |
| code compiles | real build/typecheck |
| requirement met | acceptance scenario exercised |
| refactor without change | characterization before and proportionate suite afterward |
| robust wait | observable event/condition and diagnostic timeout |

A test does not prove a build, lint does not prove runtime behavior, and a green suite does not prove a requirement absent from the oracle.

## Oracle gate

Before the body of a non-trivial test:

1. name the mutation or production defect it should detect;
2. derive the expected outcome from a contract, domain rule, or independent calculation;
3. avoid using the same helper, builder, or algorithm as the unit under test to construct the expected outcome;
4. test behavior, effect, output, or exit code, not textual presence through `grep`.

If the relevant control is removed and the test remains green, the test does not prove that control.

## Mocks and effects

- Identify effects that are part of the contract before mocking.
- Mock the lowest possible external/slow boundary.
- Preserve required real effects and the real data structure.
- Do not use mock expectations as the main evidence of correctness.
- Prefer integration when wiring, serialization, transaction, or persistence is part of the risk.

## Time, concurrency, and refactoring

Replace arbitrary `sleep` with a wait for an event or condition, with a timeout that explains the observed state. A fixed delay is appropriate only when time is an explicit part of the contract.

Before refactoring unprotected behavior, create characterization tests. Take small steps and prove the absence of change after each one.

## Ladder against invented APIs

Verify, in order:

1. repository, lockfile, imports, and types;
2. package/CLI actually installed and `--help`;
3. official documentation for the exact version;
4. release notes or official repository.

A similar signature in another version, language, or SDK is not evidence. If the evidence runs out, state the unknown.
