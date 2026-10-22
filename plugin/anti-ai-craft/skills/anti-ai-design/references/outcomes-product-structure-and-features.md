# Product structure and feature focus

## Summary

- [ADO-046 — Treat every feature as an ongoing commitment](#ado-046--treat-every-feature-as-an-ongoing-commitment)
- [ADO-047 — Justify scope through sustained value](#ado-047--justify-scope-through-sustained-value)
- [ADO-048 — Design discovery at the point of need](#ado-048--design-discovery-at-the-point-of-need)
- [ADO-049 — Distinguish opening from recurring use](#ado-049--distinguish-opening-from-recurring-use)
- [ADO-050 — Give visual precedence to the path to value](#ado-050--give-visual-precedence-to-the-path-to-value)
- [ADO-051 — Make complexity pay its cognitive cost](#ado-051--make-complexity-pay-its-cognitive-cost)
- [ADO-052 — Reduce surface area without removing autonomy](#ado-052--reduce-surface-area-without-removing-autonomy)
- [ADO-053 — Preserve validated habits during change](#ado-053--preserve-validated-habits-during-change)
- [ADO-054 — Close the feature lifecycle](#ado-054--close-the-feature-lifecycle)
- [ADO-055 — Change to resolve demonstrated friction](#ado-055--change-to-resolve-demonstrated-friction)
- [ADO-056 — Distinguish demand, activation, adoption, and continuity](#ado-056--distinguish-demand-activation-adoption-and-continuity)
- [ADO-057 — Turn dashboards into actionable guidance](#ado-057--turn-dashboards-into-actionable-guidance)
- [ADO-058 — Use interface behavior as evidence](#ado-058--use-interface-behavior-as-evidence)

## ADO-046 — Treat every feature as an ongoing commitment

**Strength.** default

**Apply when.** A new feature appears small but adds concepts, states, support, documentation, or permissions to the product.

**Decision.** Evaluate the proposal by its lasting benefit, the audience that will use it, learning cost, required states, and future maintenance; prefer the smallest version that can verify the hypothesis.

**Evidence.** There is an identifiable task, a defined user or segment, a complete flow, anticipated error and recovery states, and an observable adoption or success criterion.

**Avoid.** Accepting features merely because they are easy to implement, were requested in isolation, or make a demonstration more impressive.

## ADO-047 — Justify scope through sustained value

**Strength.** heuristic

**Apply when.** Several improvements, integrations, or variations of the same capability must be prioritized.

**Decision.** Compare contribution to the primary task, specificity to the audience, delivery effort, and operating cost; treat prioritization as an explicit hypothesis, not an automatic formula.

**Evidence.** The choice records which user outcome it improves, which alternative was deferred, and which signals may invalidate the priority.

**Avoid.** Turning scores into false authority, ignoring normative requirements, or sacrificing accessibility, security, and compatibility for an estimated return.

## ADO-048 — Design discovery at the point of need

**Strength.** default

**Apply when.** A relevant capability exists but people do not find it during the task in which it would be useful.

**Decision.** Make the capability recoverable in the context of use with a guiding empty state, contextual suggestion, or visible next step; preserve the option to dismiss the guidance.

**Evidence.** The point of need, preceding action, and return path are documented; users can discover and understand the capability without depending on an external announcement.

**Avoid.** Blocking the task with long tours, repeating ignored notices, using permanent badges, or confusing discovery with pressure to adopt.

## ADO-049 — Distinguish opening from recurring use

**Strength.** heuristic

**Apply when.** The team uses clicks, visits, or opening a menu as proof that a feature created value.

**Decision.** Define meaningful use according to the task, its expected frequency, and the outcome produced; analyze recurrence, abandonment, and need for assistance alongside simple exposure.

**Evidence.** The metric or study distinguishes curiosity, one-off testing, and completion of a useful task, with a stated period and population.

**Avoid.** Imposing a universal frequency, treating incomplete telemetry as complete human behavior, or collecting more data than necessary.

## ADO-050 — Give visual precedence to the path to value

**Strength.** default

**Apply when.** A screen organizes large amounts of information but does not make clear which action or information enables progress on the primary task.

**Decision.** Use position, sequence, contrast, grouping, and language to distinguish context, dominant action, supporting information, and progressive details; keep important alternatives accessible.

**Evidence.** The hierarchy remains perceptible without decorative color or effects, and users can identify the next step without memorizing hidden paths.

**Avoid.** Making a dominant action appear mandatory when there are legitimate choices, hiding material consequences, or reducing every secondary option to opaque menus.

## ADO-051 — Make complexity pay its cognitive cost

**Strength.** heuristic

**Apply when.** The surface accumulates options, fields, settings, or modules that make the task harder to understand.

**Decision.** Retain complexity only when it supports a real need; group by intent, reveal detail according to the task, and provide advanced routes without degrading the frequent flow.

**Evidence.** Every group, choice, or setting has a defined purpose, audience, and state; tests or usage evidence show that the organization reduces error or effort.

**Avoid.** Applying a numerical feature limit, hiding controls needed by experts, or turning simplification into a loss of power and transparency.

## ADO-052 — Reduce surface area without removing autonomy

**Strength.** default

**Apply when.** Usage data indicates that parts of the interface are rarely used, confusing, or compete with the primary task.

**Decision.** Consider simplifying, reordering, progressively revealing, or moving access to the appropriate context; preserve a discoverable route to capabilities still needed by smaller groups.

**Evidence.** The decision identifies who will be affected, how the capability remains accessible, which documentation or migration is necessary, and how reversals will be handled.

**Avoid.** Removing behavior without evidence, hiding critical settings, breaking links or experienced users' flows, and treating low frequency as absence of value.

## ADO-053 — Preserve validated habits during change

**Strength.** default

**Apply when.** A frequent, familiar part of the product will be reorganized, renamed, or given a new interaction pattern.

**Decision.** Preserve useful invariants, introduce a proportionate transition, and test the path of existing users; change the mental model only when the demonstrated gain exceeds the cost of relearning.

**Evidence.** There is evidence of frequency, current behavior, and reason for the change; navigation, shortcuts, focus, URLs, and return remain consistent or have a clear migration.

**Avoid.** Redesigning for novelty, calling an internal preference an improvement, or assuming familiarity is irrational resistance.

## ADO-054 — Close the feature lifecycle

**Strength.** required

**Apply when.** A feature will be created, changed, deprecated, or removed.

**Decision.** Design introduction, discovery, permissions, states, maintenance, migration, deprecation, removal, and recovery. Define from the outset which evidence will support expansion, correction, or retirement.

**Evidence.** The plan identifies owners, consumers, data, states, dependencies, compatibility policy, and exit condition; removals preserve work and provide a verifiable path.

**Avoid.** Treating launch as the end of the work, retaining an ownerless option, silently removing a capability, or leaving orphaned data and navigation.

## ADO-055 — Change to resolve demonstrated friction

**Strength.** required

**Apply when.** There is a desire to refactor or redesign an interface that already works.

**Decision.** State the user friction, requirement, or observable failure that the change resolves, and bound the invariants that must not regress; prefer verifiable refinement over cosmetic replacement.

**Evidence.** Before implementation, the proposal identifies prior behavior, evidence, expected outcome, regression risk, and proportionate validation.

**Avoid.** Justifying broad work through visual fatigue, a market trend, component availability, or a vague promise of modernization.

## ADO-056 — Distinguish demand, activation, adoption, and continuity

**Strength.** default

**Apply when.** An opening, sign-up, click, or usage metric is presented as proof that a feature creates value.

**Decision.** Separate initial interest, first outcome, incorporation into work, and useful continuity. Design and evaluate each stage with its own signals without assuming that progress in one guarantees the next.

**Evidence.** The analysis uses compatible cohorts and shows transitions between stages, time, abandonment, and perceived value; missing instrumentation appears as a gap.

**Avoid.** Calling a click adoption, confusing curiosity with demand, or celebrating recurring use of a task that does not benefit the person.

## ADO-057 — Turn dashboards into actionable guidance

**Strength.** default

**Apply when.** A dashboard, report, or home page concentrates metrics, tables, and alerts without guiding what the person can do next.

**Decision.** Prioritize the question the surface helps answer, highlight information interpretable in context, and connect relevant deviations to a safe next action; keep detailed data available for investigation.

**Evidence.** Every visualization has an audience, supported decision, data source, empty/error state, and interpretation limit; the related action respects permissions and does not produce an effect without appropriate confirmation.

**Avoid.** Turning every number into a CTA, inventing causality, hiding necessary raw data, or using color and urgency to simulate severity.

## ADO-058 — Use interface behavior as evidence

**Strength.** required

**Apply when.** A visual, structural, or flow decision is intended to improve a user or product outcome.

**Decision.** Formulate a falsifiable hypothesis, select proportionate evidence—research, observation, support, accessibility, minimized telemetry, or an experiment—and record the condition that would show the hypothesis failed.

**Evidence.** Baseline, segment, period, limitation, expected effect, and possible harm are stated; results do not confuse correlation, internal preference, and causality.

**Avoid.** Using vanity metrics, declaring success without an adequate comparison, collecting sensitive telemetry without need, or retaining a change that harms access and autonomy.
