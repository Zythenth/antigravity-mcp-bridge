# Design review template

Use only the applicable fields. Deliver it in the response by default; save a file or permanent captures only with authorization.

## Summary

- Scope:
- Mandate:
- Sources of truth:
- Code/baseline state:
- Evidence profile:
- Environment/runtime:
- Gate: pass / pass with reservations / block / human decision
- Coverage:
- Limitations:
- Residual risk:

## Evidence profiles

| Profile | Evidence | Permitted claims |
|---|---|---|
| Full runtime | Executable app and accessible surfaces | Rendered result, interaction, and exercised states |
| Partial runtime | Only part is reachable | Only observed surfaces and states |
| Visual artifact | Supplied screenshot or video | Appearance visible in that frame |
| Code only | Code/diff without reliable execution | Structure, potential implementation, and technical risk |

Do not claim rendered visual quality from code alone. Do not infer keyboard behavior, semantics, responsiveness, or states absent from an isolated capture.

## Evidence manifest

| ID/file | Origin | Surface | State/data | Dimensions/scale | Theme/input | Environment | Comparable to |
|---|---|---|---|---|---|---|---|

A capture proves a symptom, not necessarily its cause. Code may explain the cause, but alone it does not prove the visual result.

## Coverage matrix

| Surface | Criticality | States | Viewports | Theme/input | Evidence | Disposition |
|---|---|---|---|---|---|---|

Sample by risk, sharing, and criticality. Record `covered`, `partial`, `blocked`, `not exercised`, or `not applicable`. Do not require the Cartesian product of every combination.

## Preserved decision

| Element | Evidence | Why it works | Invariant |
|---|---|---|---|

Do not fill this with generic praise. Omit it if nothing was proven.

## Findings

### ADR-001 — Title

- Feature/phase:
- Current artifact:
- Area:
- Classification:
- Severity:
- Confidence:
- Priority:
- Gate:
- Surface/route:
- State/viewport/theme:
- File/line/component:
- Visual evidence:
- Technical evidence:
- Control or cause:
- Actor and preconditions:
- Strongest disconfirming evidence:
- Evidence gap:
- Impact:
- Rationale:
- Rule or contract:
- Suggested fix:
- Fix risk:
- Acceptance criteria:
- Required validation:

Repeat only for supported findings. Aesthetic preference and product decision remain separate.

## Flow consistency

| Related ID | Decision/requirement | Feature/phase | Current artifact | Implementation/runtime | Disposition | Evidence |
|---|---|---|---|---|---|---|

Classify divergence as a defect, valid later decision, superseded artifact, ambiguity, or evidence gap.

## Candidates and false positives

| Candidate | Evidence examined | Disposition | Reason |
|---|---|---|---|

## Failures and untested areas

Record an unavailable runtime, blocked route, missing credential/data, failed capture, external asset, invalid comparison, divergent environment, and insufficient tests. An operational failure is not automatically a product defect.

## Optional application plan

| ID | Expected outcome | Dependencies | Risk | Acceptance | Evidence |
|---|---|---|---|---|---|

The plan does not authorize editing. Request explicit selection of IDs and preferably hand off to `$anti-ai-remediate`.
