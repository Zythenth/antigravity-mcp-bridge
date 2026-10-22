# Responsible AI differentiation and delivery

## Summary

- [ADO-095 — Trade delivery speed for clarity at the destination](#ado-095--trade-delivery-speed-for-clarity-at-the-destination)
- [ADO-096 — Make generated outcomes inspectable and correctable](#ado-096--make-generated-outcomes-inspectable-and-correctable)
- [ADO-097 — Scale autonomy to decision risk](#ado-097--scale-autonomy-to-decision-risk)
- [ADO-098 — Compress generated abundance into useful hierarchy](#ado-098--compress-generated-abundance-into-useful-hierarchy)
- [ADO-099 — Demonstrate capability with a falsifiable scenario](#ado-099--demonstrate-capability-with-a-falsifiable-scenario)
- [ADO-100 — Keep visual direction and implementation synchronized](#ado-100--keep-visual-direction-and-implementation-synchronized)
- [ADO-101 — Humanize automation at the moments that matter](#ado-101--humanize-automation-at-the-moments-that-matter)

## ADO-095 — Trade delivery speed for clarity at the destination

**Strength.** default

**Apply when.** Assisted generation reduces the time required to build screens, but people still do not understand the first task, promised outcome, or next step.

**Decision.** Evaluate delivery by the time, effort, and comprehension required to reach a first useful outcome; invest in sequence, content, states, and recovery before expanding the surface.

**Evidence.** The first task and its completion are reproducible for a new person with representative data, an error path, and an observable comprehension criterion.

**Avoid.** Using the number of screens, coding speed, or appearance of completeness as a substitute for delivered value.

## ADO-096 — Make generated outcomes inspectable and correctable

**Strength.** required

**Apply when.** The product generates a recommendation, text, media, classification, or decision through a probabilistic process or incomplete context.

**Decision.** Allow people to inspect input, context, limits, and origin when relevant; provide editing, retry, comparison, reversal, or reporting before consequential use.

**Evidence.** Representative tests include a correct output, a plausible but incorrect output, refusal, and stale information; the person can identify and correct the outcome without restarting all work.

**Avoid.** Presenting output as authority, hiding decisive context, replacing human review with a confidence badge, or making automation irreversible.

## ADO-097 — Scale autonomy to decision risk

**Strength.** required

**Apply when.** Automation recommends or executes actions affecting money, data, access, communication, reputation, security, or other people.

**Decision.** Increase confirmation, explanation, preview, limits, records, and reversibility according to the consequence and difficulty of recovery. Retain meaningful human approval at high-risk points.

**Evidence.** The action matrix relates risk level, authorization, displayed information, owner, log, cancellation, and recovery; limits are tested against plausible abuse and error.

**Avoid.** Executing merely because the technology permits it, using ritual confirmation no one can evaluate, or hiding which action was taken and by whom.

## ADO-098 — Compress generated abundance into useful hierarchy

**Strength.** default

**Apply when.** Rapid generation produces many suggestions, drafts, alerts, variations, or competing outcomes.

**Decision.** Group duplicates, order by the task objective, reveal the selection criterion, and preserve access to detail, filtering, and refinement. Treat volume as raw material, not delivered value.

**Evidence.** People find the relevant outcome, recognize critical items, and understand why something received priority; evaluation includes omissions and false emphasis.

**Avoid.** Dumping every output, using novelty as priority, hiding useful diversity, or presenting opaque ordering as objective truth.

## ADO-099 — Demonstrate capability with a falsifiable scenario

**Strength.** default

**Apply when.** A page, demonstration, or onboarding flow must explain what an automated capability actually does.

**Decision.** Show a representative scenario with input, output, time, human role, dependencies, limits, and recovery. Clearly identify whether the experience is live, recorded, simulated, or hypothetical.

**Evidence.** The scenario can be reproduced in the current version or has documented data and conditions; known failures appear alongside the capability they qualify.

**Avoid.** Theatrical animation presented as the product, fabricated latency or progress, a cherry-picked outcome without conditions, or a demonstration that depends on hidden intervention.

## ADO-100 — Keep visual direction and implementation synchronized

**Strength.** required

**Apply when.** Prototypes, visual generation, the design system, and code evolve through different tools or people.

**Decision.** Define the source of truth, token and component chain, owners of updates, and validation of real consumers; change the smallest layer that expresses the intent.

**Evidence.** Implemented components and states use the intended chain, changes have a traceable origin, the build contains no known divergence, and review compares runtime with current direction.

**Avoid.** Maintaining competing style copies, adjusting loose values to imitate a prototype, importing a visual library without need, or treating a screenshot as a complete specification.

## ADO-101 — Humanize automation at the moments that matter

**Strength.** default

**Apply when.** An automated interaction confirms, fails, refuses, guides recovery, or represents a consequence that may affect trust.

**Decision.** Use direct language, proportionate feedback, explicit expectations, and a recoverable next step; anticipate predictable errors without hiding limits, uncertainty, or a necessary human decision.

**Evidence.** Messages explain what occurred, the current effect, data involved when relevant, safe options, and how to obtain help; the same states work without animation, color alone, or hover.

**Avoid.** Simulating human understanding, fabricating progress, using disproportionate celebration, blaming the person for the error, or hiding that a decision was automated.
