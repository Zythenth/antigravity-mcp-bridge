# Severity and confidence model

## Severity

### Critical

Likely exploitation with severe impact; broad loss/corruption; sensitive exposure; missing critical control; essential use blocked for many users. Require a demonstrable path, not an abstract hypothesis.

### High

Broken primary function, incorrect authorization, major accessibility regression, dangerous mutation/rollback, hidden critical action, or architecture that causes a concrete failure.

### Medium

Incorrect secondary behavior, code that is materially fragile to maintain, a test that gives false confidence, incomplete responsiveness/state, or a generic pattern that harms the task/hierarchy.

### Low

Localized problem, limited risk, minor inconsistency, or refinement with small observable impact.

### Observation

Pending decision, opportunity, preference, technical debt without current failure, or insufficient information. Do not present as a defect.

## Confidence

- **High:** reproduced; clear contract; path and impact demonstrated.
- **Medium:** plausible path and strong evidence, but the environment/state prevents complete reproduction.
- **Low:** heuristically suspicious; a material condition is missing. Keep out of primary findings or present as a question.

## Remediation priority

Priority is not synonymous with severity. Consider dependencies, recurrence, opportunity cost, availability of a safe fix, normative requirements, and the operational window. A high-severity finding may await a critical product decision; a recurring medium-severity finding may be fixed first because it reduces several risks.

## Finding classification

- confirmed functional defect;
- vulnerability;
- accessibility;
- traditional code smell;
- contextual generic pattern;
- community heuristic;
- preference;
- product decision;
- insufficient evidence or rejected false positive.

## Calibration rules

- Impact without reachability does not determine severity.
- Aesthetic complexity does not increase severity.
- A smell does not become a bug without behavior.
- A vulnerability requires a boundary, a missing control, and impact.
- An applicable WCAG failure may block delivery even without a crash.
- Multiple recurring low-severity findings may form a systemic problem; record the relationship without inflating each item.
- Confidence and severity are separate axes.
- Calibrate realistic maximum impact, reachability/preconditions, likelihood, scope, sensitivity, and reversibility.
- Report severity, confidence, and priority in separate fields.
