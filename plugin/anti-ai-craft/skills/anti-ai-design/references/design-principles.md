# Contextual design principles

## Summary

- [Decision model](#decision-model)
- [Briefing and sources of truth](#briefing-and-sources-of-truth)
- [Identity and composition](#identity-and-composition)
- [Density, cards, and bento](#density-cards-and-bento)
- [Application structure](#application-structure)
- [Three-dot menu](#three-dot-menu)
- [Visual language](#visual-language)
- [Content, microcopy, and states](#content-microcopy-and-states)
- [Responsiveness](#responsiveness)
- [Portable measurable criteria](#portable-measurable-criteria)

## Decision model

Require every relevant decision to respond to at least one of these factors:

1. user;
2. task;
3. domain;
4. data and content;
5. state;
6. identity;
7. hierarchy;
8. functional, technical, or normative constraint.

If the only rationale is “it is modern,” “it looks premium,” “the component exists,” or “it is the generator's default,” treat it as a likely default and reassess.

## Briefing and sources of truth

- Define the primary task, secondary tasks, frequency, risk of error, and definition of success.
- Identify audiences, context of use, devices, input, language, localization, and access needs.
- Read the design guide, design system, tokens, components, README, specification, code, assets, tests, and user decisions.
- Inventory minimum, maximum, absent, slow, invalid, unauthorized, and offline data states.
- Preserve valid local patterns. Do not import identity from external references.
- Use one dominant reference only for direction; record which characteristics are adopted, adapted, and rejected.

## Identity and composition

- Derive identity from vocabulary, content, materials, information relationships, and product behavior.
- Separate signature from ornament. A signature may be a composition, typography, rhythm, data representation, or interaction that belongs to the domain.
- Make the primary task quickly identifiable.
- Make area, position, contrast, scale, and proximity reflect importance and relationship.
- Prefer recognition over recall: keep options, state, context, and next steps visible or recoverable at the point of use. Do not require people to remember codes, paths, hidden conventions, or information from another screen.
- Use asymmetry for priority and symmetry for comparison; neither is a universal default.
- Use space for reading, touch, and grouping, not for scenic emptiness.
- Make the hierarchy survive without glow, gradients, shadows, borders, and color.

## Density, cards, and bento

- Choose density based on volume, frequency, environment, and required precision.
- Prefer proximity, alignment, dividers, lists, tables, and summary lists before boxes.
- Use a card when the content is a self-contained unit, has its own action/state, or must move as a group.
- Apply the boxless test: remove the border; if the relationship remains clear and the box has no function, remove it.
- Use bento only for a genuine modular overview with proven hierarchy and mobile order.
- Avoid card inside card and surface levels without a depth model.

## Application structure

### Sidebar and top bar

- Use a sidebar for persistent, frequent destinations, not to simulate a dashboard.
- Use a top bar for real navigation, search, action, or context; do not create a strip of decorative metrics.
- Keep names, location, active state, keyboard behavior, and focus consistent.

### Hero

- Reserve a hero for communication or onboarding that genuinely needs a dominant proposition.
- Do not insert a promotional hero into an operational flow, dense panel, or tool without justification.

### Tables and lists

- Use a table for two-dimensional comparison.
- Use a list for homogeneous records and a summary list for label/value pairs.
- Preserve headers, context, semantics, sorting, and local overflow when two-dimensionality is necessary.

### Forms

- Group by task, not by cardification.
- Use a persistent label; a placeholder is an example.
- Preserve values after an error and provide objective recovery.
- Keep the primary action visible and named with a concrete verb.

### Modals

- Use for a short, focused, blocking task.
- Avoid for long-form reading, comparison, primary navigation, a complex form, or a nested modal.
- Implement name, initial focus, containment, Escape, visible close, inert background, and focus return.

### Tabs

- Use for sibling panels in the same context when simultaneous comparison is unnecessary.
- Do not disguise primary destinations as tabs.
- Implement the tab–panel relationship, state, roving tabindex, and the platform pattern's keys.

### Menus, search, and overflow

- Use search only with representative domain data and distinct states:
  initial empty, no results, loading, error, and unavailable. Real data follows
  the gates for necessity, authorization, minimization, and redaction.
- Use menus for coherent sets of actions; avoid deep submenus.
- Treat a tooltip as an explanation, never as the only access to an action or essential information.

## Three-dot menu

Before creating a kebab menu, ellipsis, or generic “actions” column, inventory every action on the object and its frequency. Adopt overflow only when there are two or more genuinely secondary, infrequent, related actions, or a proven space constraint. With a single action, display it directly. If edit, save, run, or another frequent action is in the menu, redesign the hierarchy before accepting the component.

A kebab or ellipsis menu:

- is not forbidden and does not prove authorship;
- serves secondary actions related to the same object;
- must not appear on every row or card by reflex;
- must not be copied by a `map` to every item without a model of per-item actions and states;
- does not replace hierarchy;
- must not contain only one action;
- must not hide save, edit, confirm, run, or critical delete without justification;
- keeps primary and frequent actions visible;
- uses a named trigger and expanded state;
- supports keyboard, initial focus, arrow keys according to the pattern, Escape, and focus return.

During review, count occurrences, open real examples, and verify how many menus contain zero, one, or repeated actions. Do not approve the pattern merely because it saves width or already exists in the component kit.

## Visual language

### Tokens and consumers

- Organize tokens into explicit layers: `primitive → semantic → component`.
- Use primitives for raw values, semantic tokens for intent, and component tokens only when there is justifiable local variation.
- Make real components consume semantic or component tokens; do not maintain a decorative taxonomy while the code uses loose hex values, spacing, or radius values.
- Verify states such as hover, focus, disabled, error, success, contrast, and theme. A token without a consumer, or a consumer that bypasses the chain, must be removed, connected, or justified.
- Consider the system complete for the scope only when source and format match the stack, semantic roles are defined, real consumers and critical states were verified, known loose values are bounded, and the migration does not absorb debt outside the request.

### Typography

- Choose families based on voice, legibility, languages, performance, and roles.
- Limit roles; do not impose a universal number of fonts.
- Use mono for code/data when it aids reading; avoid mono throughout as a reflexive aesthetic.
- Limit uppercase and tracking to short content that remains legible.

### Color

- Map each color to a semantic or identity role.
- Do not rely on color alone.
- Use gradients, glass, glow, texture, and shadows only when they have an explainable function.
- Treat shadow as an elevation relationship, not as a “premium” finish.

### Borders, radius, and icons

- Use a border for grouping, fields, state, focus, or separation.
- Vary or limit radius according to shape and hierarchy; do not round everything automatically.
- Use a coherent icon set; provide a label or accessible name; hide decorative icons.
- Do not use emoji or sparkles as the default icon system.

### Motion

- Use motion for spatial relationships, state changes, or feedback.
- Classify material motion as feedback, spatial transition, orientation, or decoration/ambience. Require an observable function for the first three and justification, containment, and an alternative for the last.
- Avoid staggered animation, bounce, particles, hover lift, animated backgrounds, and theatrical delay without a function.
- Respect reduced motion and keep the function comprehensible without animation.

## Content, microcopy, and states

- Use faithful content and representative data early; prefer fixtures and use
  real data only when necessary, authorized, minimized, and redacted.
- Do not invent a KPI, chart, activity, telemetry, testimonial, or state to fill a layout.
- Label fixtures, examples, placeholders, and unavailability.
- Prefer recognition over recall: show context, choices, and consequences at the point of decision.
- Write with the terms people and the domain use, in active voice and with concrete verbs.
- Use the same name for the same action in the button, title, confirmation, progress state, result, error, documentation, and related event.
- Use operational microcopy: what happened, the current effect, and the next recoverable action.
- Use numbering as a structural device only when it represents a real order, priority, or sequence. Quantitative data continues to be displayed according to the domain; for unordered sets, use an unnumbered list or suitable structure.
- Avoid slogans, promotional adjectives, and generic messages on operational surfaces.
- Cover default, hover, focus, active, selected, disabled, read-only, loading, empty, success, warning, error, offline, and permission states when applicable.
- Do not simulate duration, percentage, or stages the system does not know.

## Responsiveness

- Adapt priority, navigation, density, comparison, and actions to available space.
- Treat desktop, tablet, and mobile as related compositions, not rigid devices.
- Do not solve mobile merely by stacking desktop.
- Define breakpoints where content, reading, touch, or navigation stops working.
- Preserve immediate access to critical state and the primary action.

## Portable measurable criteria

- Applicable WCAG 2.2 Level AA.
- No global horizontal scrolling at 320 CSS px, except for genuinely two-dimensional content with local overflow.
- Text at 200% and zoom at 400% without applicable loss.
- WCAG AA minimum target of 24×24 CSS px or an exception; adopt the platform/product's larger target when appropriate.
- Zero primary actions hidden without justification.
- Zero data presented as real when it is a fixture, example, or placeholder.
- One hundred percent of colors and surfaces have an explainable role.
- Critical states are communicated through more than one channel.
- Actual review at narrow, intermediate, and wide viewports.
