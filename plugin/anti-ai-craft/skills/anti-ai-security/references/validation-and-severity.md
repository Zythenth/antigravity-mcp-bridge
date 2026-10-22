# Security validation and severity

## Candidate record

For each candidate, record:

- stable ID;
- source or action controllable by the attacker;
- nearest control;
- sink, protected operation, or invariant;
- reachable path and product surface;
- boundary and environment;
- preconditions;
- depends on;
- required decision and researched source;
- recommended posture and effect if unanswered;
- independent work completed;
- supporting evidence;
- strongest disconfirming evidence;
- evidence gaps;
- disposition: confirmed, suppressed, not applicable, depends on infrastructure, unverified, or duplicate.

Do not promote a checklist item to a vulnerability without this path.

## Falsification

1. Look for the control at the point nearest the operation.
2. Exercise the actual path, not only an isolated function.
3. Try to defeat the hypothesis through authentication, authorization, validation, state, configuration, and infrastructure.
4. Do not use a safe neighboring path to suppress another route.
5. Treat production configuration absent from the repository as a confidence gap.
6. Treat a setup, scanner, or test failure as incomplete evidence.
7. Preserve independent instances even when they share a category.

## Severity

Calibrate separately:

- **Realistic maximum impact:** confidentiality, integrity, availability, fraud, privacy, physical safety, or cost.
- **Reachability and preconditions:** public/internal access, role, victim interaction, secret, timing, state, and infrastructure control.
- **Likelihood:** ease, reliability, detectability, and incentive.
- **Scope:** one object, user, tenant, service, or platform.
- **Sensitivity:** nature and volume of data/resources.
- **Reversibility:** detection, recovery, rotation, chargeback, and permanent loss.

High/critical requires a real path and material impact. Keep **severity**, **confidence**, and **remediation priority** as distinct axes.

## Deduplication

Group only when the items share:

1. the same control or root cause;
2. the same exploitable behavior;
3. the same impact;
4. the same fix.

Preserve all locations and their dispositions. A shared fix does not make occurrences indistinguishable.

## Fix gate

Before editing:

- confirm that the finding still exists;
- freeze the path and expected outcome;
- define a negative test and positive legitimate use;
- map siblings, aliases, and bypasses;
- separate structural hardening from the approved fix.

Afterward:

- the original path no longer reproduces;
- legitimate use continues to work;
- the test fails if the control is removed;
- siblings and bypasses were verified;
- the evidence was rerun after the latest change.
