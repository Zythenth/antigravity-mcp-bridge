# Visual review workflow

## Summary

- [Preflight](#1-preflight)
- [Structure without decoration](#2-structure-without-decoration)
- [Content and states](#3-content-and-states)
- [Direction and alternatives](#4-direction-and-alternatives)
- [Authorized implementation](#5-authorized-implementation)
- [Capture and evidence profile](#6-capture-and-evidence-profile)
- [Separate passes](#7-separate-passes)
- [Before/after comparison](#8-beforeafter-comparison)
- [Human gate](#9-human-gate)
- [Report](#10-report)

## 1. Preflight

- Record the scope and whether editing is authorized.
- Read sources of truth and the code state.
- List users, tasks, screens, routes, data, and states.
- Classify relevant elements as direct reuse, composition, extension, creation, out of scope, or unknown, with evidence.
- Classify the surface and preserve/refine/redesign mandate.
- List relevant likely defaults; do not impose a ritual count.
- Separate existing identity from decoration.
- Define acceptance criteria and viewports.
- Confirm whether the target is local, preview, staging, or production, and which operations are
  read-only. Do not assume running the UI authorizes external effects.
- Set the direction contract and dominant reference when there is creation or redesign.
- Record the files, versions, sections, screens, and artifacts actually read, linking every decision to the corresponding evidence.
- Record material decisions by ID, dependency, origin, and state when necessary; stop when no open branch changes direction or criteria.

## 2. Structure without decoration

Review in grayscale and, when possible, without effects:

- reading order;
- primary action;
- hierarchy;
- grouping;
- density;
- focus sequence;
- priority by viewport.

For a navigable product, also run a structural pass in the reachable runtime:

- check entry points, destinations, global/local/contextual navigation, and labels;
- exercise direct URLs, refresh, back/forward, return to context, and persistence;
- verify no-access, missing-destination, interruption, error, and recovery states;
- compare the perceived hierarchy with the task and current information architecture.

When there is no runtime, limit the pass to the available profile and record which
of these behaviors remain `not exercised`.

## 3. Content and states

Prefer fixtures or explicitly marked representative data. Use real data
only when the evidence requires it, authorization exists, and it can be
minimized and redacted. Exercise:

- minimum and maximum;
- long titles and values;
- empty;
- loading/processing;
- success;
- error/retry;
- offline/unavailable;
- permission;
- critical state.

## 4. Direction and alternatives

When there is a material decision:

1. formulate two or three composition theses;
2. explain each one's connection to the product and task;
3. compare legibility, density, responsiveness, accessibility, cost, and risk;
4. select a direction or request a human decision.

Do not generate equivalent cosmetic variants.

## 5. Authorized implementation

- Preserve architecture, tokens, components, and pre-existing changes.
- Implement real behavior and states.
- Avoid an unrequested dependency, asset, framework, or refactor.
- Keep the change small and traceable.
- Run the relevant lint, tests, and build.

## 6. Capture and evidence profile

Select the evidence profile first. For `full runtime` or `partial
runtime`, run the application and capture real evidence, using the same
data/state before and after and recording viewport, scale, theme, and flow. Include
reachable critical states, not only the happy path.

Before interacting, confirm the environment and separate read-only navigation from
mutable operations. Submitting a form, sending a message, uploading, paying,
deleting, writing to a database, or making an external call with effects requires
specific authorization. Do not use production when local, preview, or staging can prove the same
behavior. Redact secrets, credentials, PII, and customer content from
screenshots, files, and responses; if redaction destroys the evidence, record the
limitation instead of exposing the data.

For a `visual artifact`, analyze only the supplied screenshot or video. For
`code only`, inspect structure and potential risk without requiring execution or
capture and without claiming a rendered result.

When the scope is responsive and the project defines no breakpoints or test
viewports, use `375×812`, `768×1024`, and `1280×800` as reproducible probes for
narrow, intermediate, and wide. They are investigative fallbacks, not new
breakpoints or a mandatory matrix; reduce or expand the sample according to risk,
platform, and affected surfaces.

Review does not edit by default. Without authorization, keep captures in a temporary location outside the target or present them in the conversation. Persist screenshots or a report in the project only at an authorized path consistent with its conventions.

Available profiles:

1. **Full runtime:** executable app, reachable surfaces and states.
2. **Partial runtime:** claims limited to what was reached.
3. **Visual artifact:** only what is visible in the supplied screenshot or video.
4. **Code only:** structure and potential risk, without claiming rendered visual quality.

Before declaring final validation, require an executable target, known input, reproducible state/data, defined viewport/theme, and prior criteria. Otherwise, label the review as a plan, static, or prototype review and state what it does not prove.

Create a proportional matrix by surface, criticality, states, viewports, theme/input, evidence, and disposition. Use `covered`, `partial`, `blocked`, `not exercised`, or `not applicable`; do not require the Cartesian product of combinations.

## 7. Separate passes

Conduct two independent passes before synthesis:

1. **Visual/UX, without consulting a detector or style checklist:** function, content, task, hierarchy, language, density, and recovery.
2. **Technical/deterministic:** keyboard/focus, semantics/screen reader, contrast/forced colors, zoom/reflow/text spacing, motion/reduced motion, performance, and regressions.

For each candidate, apply the gate:

1. which contract, task, or requirement is relevant;
2. whether the path/component is reachable in the runtime;
3. which correction the evidence actually determines;
4. which observation would defeat the finding.

Exercise representative scenarios: novice and experienced user, keyboard and screen reader, mobile with interruption, error/undo/recovery, and extreme content. Do not replace this with universal numerical limits.

In the content pass, confirm recognition rather than recall, user terminology, active voice, a consistent name for the action throughout the flow, and numbering reserved for real sequences. In the visual/technical pass, confirm the `primitive → semantic → component` chain in real consumers and states.

When tokens are changed, verify aliases, source versus generated output, representative consumers, modes, and states. When multiple themes are in scope, cross critical states with at least one narrow and one wide viewport, including focus, error, disabled, loading, overlays, media, forced colors, and reduced motion when applicable.

Connect the rendered symptom to the technical cause and look for disconfirming evidence. A screenshot alone does not prove the cause; code alone does not prove the visual result.

## 8. Before/after comparison

For each change, record:

- previous problem;
- evidence;
- decision;
- observable outcome;
- potential regression;
- validation performed.

Do not declare “better” based on preference alone. Compare task, time, error, legibility, access, density, and consistency.

When flow artifacts exist, compare the task, brief, information architecture, tokens, plan, implementation, and runtime. Classify divergence as a defect, valid later decision, superseded artifact, ambiguity, or evidence gap.

## 9. Human gate

Request approval before:

- changing identity, primary navigation, or composition thesis;
- replacing the design system;
- changing many screens;
- removing a recognizable pattern;
- choosing among alternatives with product tradeoffs;
- accepting a broad visual change even when technically valid.

Block delivery for a functional failure, loss of data/focus, hidden primary action, fabricated content, global overflow, state communicated only by color, or applicable WCAG regression.

## 10. Report

Use [design-review-template.md](design-review-template.md) for a formal review. Separate severity, confidence, priority, and gate. Include the evidence profile, coverage, capture manifest, source of truth, screenshot/viewport/state/theme, component/file/line, deviation, impact, disconfirming evidence, suggested fix, risk, and acceptance criteria. Record effective decisions that must be preserved and state what was not tested.

Emit `ADR-*` IDs for supported findings. Review ends with the report; offer application only after explicit selection of IDs, preferably through `$anti-ai-remediate`.
