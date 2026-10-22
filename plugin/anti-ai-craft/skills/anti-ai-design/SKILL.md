---
name: anti-ai-design
description: "Research, create briefs, plan information architecture or tokens, review, implement, or refactor contextual, outcome-oriented interfaces without automatically resorting to generic composition or manipulative tactics. Use when the request involves screenshots, wireframes, frontend, visual components, scoped interface flows, navigation, design systems, accessibility, responsiveness, landing pages, onboarding, activation, pricing, retention, or product metrics; do not use to orchestrate a complete or multiphase journey, such as from briefing through review, or for code without a visual component. Read project sources and supplied visuals, treat business outcomes as hypotheses subordinate to the task, and edit only when authorized by the user."
---

# Anti-AI Design

Treat “anti-AI” as a design discipline, not an authorship detector. Never claim that a person or model wrote an interface. Evaluate whether decisions about composition, components, content, and decoration respond to the user, task, domain, data, state, identity, hierarchy, and product constraints.

## Prepare the work

1. Confirm the scope: research, analysis, planning, review, or implementation.
2. Read the available sources of truth before proposing an aesthetic: design guide, design system, README, specification, code, assets, tests, and user decisions.
3. Classify the predominant surface: **persuade**, **operate**, **read**, or **experience**. An operational application must not automatically receive the composition of a landing page.
4. Set the mandate: **preserve**, **refine**, or **redesign**. The absence of `DESIGN.md` does not mean greenfield; local polish does not authorize rebranding.
5. Identify users, critical tasks, devices, representative or authoritative content, states, and accessibility requirements.
6. Record only material decisions and their dependencies. Resolve facts in the project before asking; in rounds of no more than two or three questions, include a recommendation, rationale, consequences, and the independent work that can continue. State low-risk assumptions; do not invent product details, data, or identity.
7. Classify the relevant elements in scope as `reuse`, `compose`, `extend`, `create`, `out of scope`, or `unknown`, citing real components, APIs, states, and consumers.
8. Preserve project-specific rules. Make applicable functional requirements and WCAG prevail over aesthetic heuristics.
9. When the request is a complete, multiphase, resumable journey, direct the user to explicitly invoke `$anti-ai-design-flow`; keep this skill suited to scoped visual work.

## Load references as needed

- Read [design-principles.md](references/design-principles.md) for briefing, composition, components, visual language, content, states, and responsiveness.
- Read [design-brief.md](references/design-brief.md) when creating or updating a brief.
- Read [information-architecture.md](references/information-architecture.md) for navigation, routes, hierarchy, persistence, or flow across surfaces.
- Read [design-tokens.md](references/design-tokens.md) for tokens, themes, palette, typography, scale, or design systems.
- Read [design-antipatterns.md](references/design-antipatterns.md) when detecting likely defaults or reviewing a generic appearance.
- Read [accessibility-baseline.md](references/accessibility-baseline.md) for every interface creation, refactor, or audit.
- Read [direction-contract.md](references/direction-contract.md) before creating, refining, or redesigning an interface.
- Read [visual-library/README.md](references/visual-library/README.md) only when creation, refinement, or redesign would benefit from external visual references. Select a family from the task, inspect only the necessary items, treat the collection as non-normative, lock one dominant reference, and do not copy identity, brand, or a composition unrelated to the current domain.
- Read [review-workflow.md](references/review-workflow.md) when implementing, capturing screenshots, or comparing before and after.
- Read [design-review-template.md](references/design-review-template.md) when producing a formal review or finding handoff.
- Read [sources.md](references/sources.md) when a rule needs justification, a conflict needs resolution, or a requirement must be distinguished from guidance or a heuristic.
- Read [outcomes-method.md](references/outcomes-method.md) when the interface has an acquisition, activation, adoption, monetization, continuity, differentiation, or other product-metric objective.
- Read [outcomes-context-and-strategy.md](references/outcomes-context-and-strategy.md) for outcomes, stage, surface, scope, and strategy.
- Read [outcomes-positioning-and-promise.md](references/outcomes-positioning-and-promise.md) for audience, category, positioning, promise, and cross-channel consistency.
- Read [outcomes-acquisition-and-landing.md](references/outcomes-acquisition-and-landing.md) for acquisition, entry pages, proposition, proof, and CTA.
- Read [outcomes-onboarding-and-activation.md](references/outcomes-onboarding-and-activation.md) for first use, activation, onboarding, evaluation, and empty states.
- Read [outcomes-product-structure-and-features.md](references/outcomes-product-structure-and-features.md) for scope, discovery, adoption, lifecycle, dashboards, and features.
- Read [outcomes-pricing-and-monetization.md](references/outcomes-pricing-and-monetization.md) for plans, pricing, billing, limits, trials, and upgrades.
- Read [outcomes-retention-and-offboarding.md](references/outcomes-retention-and-offboarding.md) for continuity, support, cancellation, export, and return.
- Read [outcomes-ethical-choice-architecture.md](references/outcomes-ethical-choice-architecture.md) for defaults, persuasion, friction, urgency, social proof, and autonomy.
- Read [outcomes-metrics-and-experimentation.md](references/outcomes-metrics-and-experimentation.md) for instrumentation, metrics, research, cohorts, and experiments.
- Read [outcomes-ai-differentiation-and-delivery.md](references/outcomes-ai-differentiation-and-delivery.md) for differentiation, trust, and delivery in products created or accelerated with AI.

## Execute the workflow

1. Read the project and record the initial state when code is present.
2. Identify the task and users.
3. Locate existing rules and order them by authority.
4. When there is a product or business outcome, read the outcome-oriented method, distinguish the person's outcome from the organization's outcome, select no more than three `ADO-*` IDs per decision, and define the indicator, guardrail metrics, disconfirming evidence, and reversal condition.
5. Inventory real screens, routes, components, content, media, states, and flows.
6. When there are multiple surfaces, map entry points, navigation, hierarchy, URLs, persistence, primary/alternative paths, and recovery before aesthetics.
7. Separate verifiable identity from replaceable decoration and record what must remain invariant.
8. Before coding, write a short direction contract: thesis, mode, task, first viewport, primary path, structure, color/type roles, signature, risk, and rejected category default.
9. For tokens, identify the authoritative source, generated outputs, aliases, consumers, modes, and reach before proposing values.
10. Lock one dominant reference and limit secondary references to explicit roles; do not calculate a visual average of conflicting references.
11. List likely defaults: composition, components, copy, palette, typography, motion, and overflow controls.
12. Inventory primary, frequent, secondary, and destructive actions before accepting kebab menus, ellipses, or generic menus.
13. Produce alternatives only when a material decision remains open; compare consequences, not merely styles.
14. Define component states by trigger, visual change, semantic state, permitted action, and recovery.
15. When planning a build, create vertical slices by observable outcome with origin, reuse strategy, dependencies, definition-of-done criteria, and evidence; do not automatically decompose by technology or file.
16. Implement only when authorized, preserving architecture, essential content, and product invariants.
17. Run the real interface when the review profile requires runtime evidence; calibrate claims when only a screenshot or code is available.
18. Review viewports and states by criticality, including keyboard, screen reader, interruption, and recovery.
19. First conduct a visual/UX pass without consulting detectors; then conduct a technical/deterministic pass; synthesize both with evidence.
20. Compare before and after using equivalent data, states, themes, and viewports.
21. Produce stable IDs for review findings and request explicit selection before any fix.
22. Request approval before a visually broad change or a choice that redefines identity, navigation, theme, or the global reach of tokens.

## Operate by mode

### Research or planning

Do not edit. Deliver a brief, inventory, architecture, risks, recommended direction, relevant alternatives, measurable criteria, and validation plan.

### Design brief

Use [design-brief.md](references/design-brief.md). Produce the brief in the response by default. Save it only with specific authorization, without overwriting existing material or starting implementation. Keep the state `draft`, `blocked`, `approved`, or `superseded`.

### Review

Do not edit by default or create permanent captures without authorization. State the evidence profile, coverage, and limitations. Cite a screenshot, viewport, component, file, or line when available. Separate:

- functional or normative failure;
- inconsistency with a source of truth;
- contextual generic pattern;
- heuristic;
- subjective preference;
- rejected false positive.

### Implementation

Make a small, verifiable change. Use faithful content and representative data;
prefer fixtures. Use real data only when necessary, authorized, minimized,
and redacted. Confirm the environment before running the application, and do not
submit forms, send messages, upload files, make payments, delete data, write
to a database, or make a mutable external call without specific authorization. Implement
states and behavior, not merely appearance. Run lint, tests, build, and browser review
as the project permits. Report any validation not performed.

## Output contract

Deliver, as appropriate to the mode:

- context and sources of truth read;
- task, users, content, states, and constraints;
- likely defaults and why they do or do not apply;
- direction or findings with the level of evidence;
- the person's and organization's outcomes, selected `ADO-*` IDs, primary indicator, guardrail metrics, and disconfirming evidence when there is a product or business objective;
- direction contract and dominant reference when there is creation or redesign;
- preserved, changed, and rejected decisions;
- superseded architecture, tokens, tasks, or artifacts and dependents to revalidate;
- measurable acceptance criteria;
- validations performed and evidence obtained;
- risks, gaps, and required human approval.

Do not turn dark mode, cyan, serif, mono, cards, borders, radius, symmetry, or asymmetry into universal prohibitions. An isolated signal proves neither a problem nor authorship.
