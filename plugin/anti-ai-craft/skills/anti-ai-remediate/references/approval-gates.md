# Approval gates

## Allowed by invocation

Only:

- explicitly listed/approved findings;
- necessary files and behavior;
- directly related tests and validations;
- safe, removable temporary artifacts, when necessary.

## Request new approval

- broad visual identity or navigation;
- public API change;
- data migration;
- new dependency/framework;
- broad dependency update;
- feature/compatibility removal;
- external access, credential, or service;
- destructive or difficult-to-recover action;
- fix that affects an area not included;
- alternative with a material product trade-off.
- material change to the already approved plan, risk, behavior, IDs, or scope.
- change to primary navigation, public URL, slug, persisted parameter, or return strategy;
- replacement of a global token, namespace, provider, pipeline, or theme strategy that reaches multiple surfaces, brands, modes, or platforms.

## Classify questions

- **Discoverable in the target:** investigate before asking.
- **Safe to assume without changing the contract:** state the assumption and continue.
- **Blocking due to authorization, product, or risk:** ask with a recommendation and consequences; do not treat a default as consent.

A brief or plan provides requirements and criteria but does not authorize remediation. A material change to these artifacts requires revalidating the finding and, when it affects behavior, risk, or scope, obtaining new approval.

## Stop

- finding cannot be reproduced;
- report contradicts the current code;
- cause is out of scope;
- pre-existing changes conflict;
- test requires an unavailable environment/secret;
- a safe fix depends on a user decision;
- critical validation cannot be run.
- frozen verification fails and the next attempt would require another hypothesis or material change.

Stopping does not mean inventing a fallback. Report the evidence and ask for direction.

## Prohibited without specific authorization

- stage, commit, push, PR, release, or deploy;
- reset, destructive checkout, clean, or discarding changes;
- deleting data, migrations, or snapshots;
- modifying licenses;
- reducing tests/coverage;
- disabling a security control;
- automatically approving a visual outcome;
- marking a finding as fixed without reproduction and validation.

## Completion criterion

Conclude only when every approved ID has a status and evidence:

- fixed and validated;
- fixed with partial validation explicitly stated;
- not reproduced;
- blocked by a decision/environment;
- rejected after new evidence.
- already fixed/no change;
- blocked on evidence, product, or scope;
- failed validation.
