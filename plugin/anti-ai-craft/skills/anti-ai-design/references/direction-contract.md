# Direction contract

## Summary

- [Classify the surface](#1-classify-the-surface)
- [Set the mandate](#2-set-the-mandate)
- [Write the contract](#3-write-the-contract-before-coding)
- [Lock references](#4-lock-references)
- [Preserve media and content](#5-preserve-media-and-content)
- [Contract states](#6-contract-states)
- [Check implementation readiness](#7-check-implementation-readiness)
- [Preserve structure, URL, and state](#8-preserve-structure-url-and-state)
- [Contract themes and external resources](#9-contract-themes-and-external-resources)
- [Maintain checkpoints and invalidation](#10-maintain-checkpoints-and-invalidation)
- [Boundaries](#boundaries)

Use before creating, refining, or redesigning. The contract is short and verifiable; it is not an aesthetic manifesto.

## 1. Classify the surface

- **Persuade:** explain value and guide a decision. The message and narrative sequence dominate.
- **Operate:** perform repeated tasks with speed, clarity, recovery, and low memory load.
- **Read:** sustain comprehension, navigation, and continuity through content.
- **Experience:** create presence, exploration, or atmosphere without hiding the task.

Combinations are possible, but state which mode dominates each viewport or stage.

## 2. Set the mandate

- **Preserve:** retain identity, behavior, copy, and structure; fix only the stated failure.
- **Refine:** retain identity and product; improve hierarchy, rhythm, states, accessibility, and responsiveness.
- **Redesign:** may replace the visual world, but preserves product truth, content, function, constraints, accessibility, and integrations.

Even in a redesign, do not silently change routes, slugs, anchors, primary navigation, field names/order, analytics events, consent, SEO, metadata, structured data, or existing accessibility.

## 3. Write the contract before coding

Record:

1. a one-sentence thesis;
2. dominant mode and task;
3. first-viewport promise;
4. primary user path;
5. structure and hierarchy;
6. semantic color and typography roles;
7. one meaningful signature;
8. category default consciously rejected;
9. primary risk and how it will be tested;
10. elements that must remain invariant.

The signature must serve the domain, content, or interaction. Creating one memorable decision and maintaining restraint around it generally produces more identity than scattering multiple decorative gestures.

When relevant, turn direction into verifiable decisions along these axes: typography, color roles, composition/grid, density/spacing, motion, surfaces/details, and media/iconography. Omit inapplicable axes; do not fill them with vague adjectives or presets.

## 4. Lock references

- Select one dominant source for composition and language.
- Give secondary sources limited roles, such as typography, motion, or density.
- Record the adopted decision and rejected alternative.
- Record exactly which files, versions, sections, screens, or artifacts were actually read and which decision each supports. Do not cite an entire collection when only one document was consulted.
- Preserve the `primitive token → semantic token → component token or real consumer` chain. Components must not consume primitive values directly when the system defines a semantic layer.
- Verify real consumers in the code and interface states; declare an unused token or component with a loose value as a gap, not as a complete system.
- Preserve relationships among tokens, components, content, and media; do not copy only the superficial appearance.
- When sources conflict, decide according to the task and constraint. Do not produce a visual average.

For components in scope, record the candidate found, relevant API/states, and the decision to `reuse`, `compose`, `extend`, or `create`. Do not require a complete repository census.

## 5. Preserve media and content

If the direction depends on photography, illustration, video, a map, diagram, or product screenshot, use the supplied asset or a legitimate, suitable alternative. Do not replace essential media with gradients, blobs, empty cards, or generic CSS drawings.

Preserve the slot, proportion, crop, `alt`, caption, and loading state. If the asset does not exist, state the gap; do not invent product proof.

## 6. Contract states

For each relevant interactive component, define:

- trigger;
- visual change;
- semantic and accessibility state;
- permitted action;
- recovery or next transition.

Cover loading, empty, partial, error, success, unavailable, read-only, focus, selection, expansion, and confirmation when applicable.

## 7. Check implementation readiness

- Use coherent `type`, `inputmode`, `autocomplete`, and validation.
- Make real navigation work; reflect a filter, tab, or page in the URL when the product depends on it.
- Preserve scroll, filters, and forms on return when expected.
- Test overlay clipping, safe areas, orientation, virtual keyboard, pointer, and absence of hover.
- Reserve media proportions, prioritize critical images, and defer the rest to avoid layout shift.
- Use a compatible font fallback and keep content visible without depending on animation.
- Make motion interruptible and respect reduction preferences.

## 8. Preserve structure, URL, and state

When the change affects multiple surfaces, state:

- entry points and destinations;
- global, local, contextual, and return navigation;
- routes, slugs, aliases, parameters, and deep links;
- refresh, back/forward, and resumption behavior;
- authoritative, URL-represented, local, or ephemeral state;
- required compatibility, redirects, or migration.

Use [information-architecture.md](information-architecture.md) for the complete contract. A navigation or public-URL change is material even when the visual diff appears small.

## 9. Contract themes and external resources

When there are multiple themes, record the source of truth, supported modes, precedence between system preference and manual choice, persistence, pre-hydration state, semantic roles, assets, native controls, overlays, contrast, forced colors, and reduced motion. Do not create a new theme without a requirement or authorization.

Before adding an external font, image, stylesheet, script, or visual library, look for an approved local alternative and verify applicable necessity, origin, project policy, privacy, CSP, integrity, performance, caching, fallback, and degraded operation.

## 10. Maintain checkpoints and invalidation

In the complete or resumable flow, record the feature, phase, artifacts, decisions, blockers, next input, and code state used as a reference. A file's presence does not mean the phase is complete.

Common dependencies:

```text
brief → structure and direction → tokens → plan → implementation → review
```

Adapt the relationship to the project. When an earlier decision changes, mark only the actual dependents as `revalidate`; do not update silently or rewrite the entire set.

## Boundaries

Do not treat as absolutes: a fixed number of colors/fonts, mandatory visual risk, a specific stack, universal animation duration, random direction, or a requirement to use images.
