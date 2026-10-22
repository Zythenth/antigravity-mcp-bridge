# Outcome-oriented design method

## Scope

Use this library only when the interface has an explicit objective related to acquisition, understanding the proposition, activation, adoption, monetization, continuity, or product differentiation. Do not apply funnel language to an operational surface merely because it contains buttons, metrics, or paying users.

The person's outcome and the organization's outcome must be compatible. When they conflict, preserve autonomy, accessibility, security, privacy, material information, and a comprehensible exit. A business metric does not replace the user's task.

## Authority and strength

Interpret the cards as follows:

- **required:** protects truth, autonomy, access, security, compatibility, or evidence; depart from it only for an explicit higher-order requirement and record the decision;
- **default:** recommended initial choice; adapt when the project's source of truth or contextual evidence points in another direction;
- **heuristic:** useful hypothesis for research or an experiment; never present it as a causal guarantee.

The order of authority is: applicable legal or normative requirement; project contract and invariants; explicit user decision; observable evidence; guidance; heuristic; preference.

## Decision card

Each principle has a stable ID and five fields:

- **Strength.** how much variation the rule permits;
- **Apply when.** trigger and relevant context;
- **Decision.** concrete action or design question;
- **Evidence.** evidence that supports, validates, or defeats the decision;
- **Avoid.** abuse, false positive, or application outside the context.

Select only the IDs necessary for the current problem. For a single decision, use no more than three candidate principles before synthesizing; more rules do not mean better design.

## Routing

| Predominant problem | Reference |
|---|---|
| Outcome, stage, surface, cost, and strategy | [outcomes-context-and-strategy.md](outcomes-context-and-strategy.md) |
| Audience, positioning, promise, and verbal differentiation | [outcomes-positioning-and-promise.md](outcomes-positioning-and-promise.md) |
| Acquisition, entry page, proposition, proof, and CTA | [outcomes-acquisition-and-landing.md](outcomes-acquisition-and-landing.md) |
| First use, activation, onboarding, trial, and empty states | [outcomes-onboarding-and-activation.md](outcomes-onboarding-and-activation.md) |
| Scope, hierarchy, dashboards, feature discovery, and adoption | [outcomes-product-structure-and-features.md](outcomes-product-structure-and-features.md) |
| Plans, pricing, billing, trial, limits, and upgrade | [outcomes-pricing-and-monetization.md](outcomes-pricing-and-monetization.md) |
| Continuity, lifecycle, cancellation, export, and support | [outcomes-retention-and-offboarding.md](outcomes-retention-and-offboarding.md) |
| Defaults, persuasion, friction, urgency, and social proof | [outcomes-ethical-choice-architecture.md](outcomes-ethical-choice-architecture.md) |
| Instrumentation, metrics, research, and experiments | [outcomes-metrics-and-experimentation.md](outcomes-metrics-and-experimentation.md) |
| AI-generated products, identity, trust, and delivery | [outcomes-ai-differentiation-and-delivery.md](outcomes-ai-differentiation-and-delivery.md) |

## Generation workflow

1. Confirm the task, audience, relationship stage, surface, and decision the person must make.
2. Record the promise, available evidence, constraints, real content, states, and material consequences.
3. Choose the thematic reference and applicable IDs; reject those that depend on absent facts.
4. Translate each selected principle into observable content, order, hierarchy, interaction, or state.
5. Define the person's outcome, primary indicator, guardrail metrics, disconfirming evidence, and reversal condition.
6. Design the primary path, alternative, refusal, error, interruption, resumption, and exit.
7. Verify accessibility, privacy, security, responsiveness, and consistency with the existing system.
8. Implement only with authorization and validate in the real interface when possible.

## Review workflow

Separate:

- functional, normative, or accessibility defect;
- inconsistency with the promise, task, or source of truth;
- outcome hypothesis not yet tested;
- aesthetic preference;
- tactic rejected because it risks autonomy or trust.

For each outcome-oriented finding, record the IDs used, baseline, segment, expected behavior, possible harm, current evidence, disconfirming evidence, and required validation. Do not claim an increase in conversion, retention, or revenue based on a screenshot, taste, or an external benchmark.

## Prohibitions

Never fabricate or disguise:

- scarcity, urgency, availability, or a queue;
- a testimonial, rating, logo, case, number, or result;
- progress, stage, duration, activity, or telemetry;
- consent, renewal, cost, limit, eligibility, or consequence;
- demonstration data as production data.

Do not make cancellation, refusal, export, deletion, comparison, or access to material information difficult. Do not exploit compulsion, vulnerability, fear, or confusion as a growth strategy. Do not use defaults, visual emphasis, or friction to obtain a choice that is not defensible for the person making it.

## Output contract

For outcome-oriented generation or planning, deliver:

- audience, task, stage, and surface;
- the person's outcome and the organization's outcome;
- selected IDs and reason they apply;
- content, flow, hierarchy, and state decisions;
- existing evidence, hypothesis, and unknowns;
- primary indicator, guardrail metrics, and disconfirming evidence;
- risks to autonomy, access, privacy, security, and trust;
- validation and reversal condition.
