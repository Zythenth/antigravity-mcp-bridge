# Antipatterns and false signals

## Summary

- [Interpretation rule](#interpretation-rule)
- [Composition and content](#composition-and-content)
- [Reflexive aesthetics](#reflexive-aesthetics)
- [Components](#components)
- [Motion and theatrics](#motion-and-theatrics)
- [Superficial responsiveness](#superficial-responsiveness)
- [False authorship signals](#false-authorship-signals)
- [Critique questions](#critique-questions)

## Interpretation rule

Do not treat any isolated item as proof of low quality or authorship. Look for combination, repetition, lack of rationale, and conflict with the task, content, state, identity, or accessibility.

Classify each occurrence as:

- functional or normative defect;
- inconsistency with a source of truth;
- contextual generic pattern;
- heuristic;
- subjective preference;
- rejected false positive.

## Composition and content

| Signal | Risk | Contextual decision |
|---|---|---|
| Promotional hero inside the product | displaces the task with marketing | reject unless there is genuine onboarding/communication |
| Interchangeable sidebar + top bar | turns the product into a generic dashboard | adapt to actual destinations, language, and frequency |
| Identical cards | gives equal weight and hides relationships | use a list, table, alignment, or self-contained cards |
| Bento selected before content | the recipe governs the information | accept only for a proven modular overview |
| Card inside a card | depth without a model | reduce levels or justify the subgroup |
| Automatic symmetry | erases priority | retain only for genuine comparison |
| Performative asymmetry | impairs scanning | require an informational gain |
| Universal centering | weakens reading and progression | limit to short, local states |
| Uniform spacing or scenic emptiness | relationships appear equivalent | vary rhythm by item, group, and section |
| Fictional KPI, chart, or activity | builds architecture on false data | remove or mark as a non-production fixture |
| Promotional copy in an operational flow | takes space from the task | replace with domain vocabulary and action |
| Happy path without extremes | interface looks complete without working | test empty, error, offline, loading, and overflow |

## Reflexive aesthetics

| Signal | Risk | False positive or condition |
|---|---|---|
| Purple/blue/cyan gradient | replaceable palette | valid if it belongs to the brand/data and passes contrast |
| Glassmorphism | ambiguous contrast and layers | valid in a controlled, legible overlay |
| Glow, blobs, and splotches | atmosphere without information | valid when they communicate focus/state and have a solid cue |
| High radius on everything | flattened hierarchy | rounded shapes may belong to the system |
| Pills for every action | buttons look like badges | use for a chip, toggle, or short state |
| Shadow and hover lift | “premium” without a model | shadow may communicate actual elevation |
| Dark mode | not generic by itself | assess identity, contrast, and function |
| Cream/serif/terracotta light theme | may become the new default | assess context; do not swap one preset for another |
| Acid-on-black or broadsheet | may perform difference | require a connection to the domain and legibility |
| Mono throughout | fatigue and “terminal cosplay” | useful for code, data, and metadata |
| Editorial serif | may become a template | valid for reading/voice when supported |
| Uppercase and tracking | noise and reduced readability | acceptable in codes and short labels |
| Sparkle or emoji | generic/ambiguous icon | user content or a taught symbol may be valid |

## Components

| Signal | Risk | Contextual decision |
|---|---|---|
| Kebab menu on every row/card | action becomes repetitive hunting | consolidate actions and keep frequent ones visible |
| Ellipsis with one action | unnecessary overflow | show the action directly |
| Hidden save/confirm/run | low discoverability and efficiency | keep visible |
| Hidden critical delete action | risk and lack of clarity | expose with appropriate hierarchy and confirmation |
| Icon without label/name | ambiguity and access barrier | add text, tooltip, and accessible name as appropriate |
| Table converted to cards | comparison becomes difficult | preserve the two-dimensional relationship |
| Generic component for incompatible data | structure erases semantics | create a purposeful variant or specific composition |
| Visual modal without modal behavior | focus escapes and background remains operable | implement the complete pattern or use a page |
| Visual tabs without semantics | keyboard and relationship are broken | implement the pattern or use navigation |
| Tooltip with an essential action | inaccessible on touch/keyboard | move the action to a persistent control |

## Motion and “theatrics”

- Staggered animation selected by default.
- Particles, animated background, parallax, or glitch without a function.
- Hover that shifts layout.
- Theatrical loading, artificial delay, or fabricated percentage.
- Typewriter effect that delays access to content.
- Confetti or celebration mismatched to the outcome.

Ask: does the function remain clear without motion? Does the backend measure this progress? Can the user reduce, pause, or interrupt it?

## Superficial responsiveness

- Stack every column without reprioritizing.
- Carry the entire sidebar/top bar into mobile.
- Hide critical state because of fixed positioning.
- Clip text or an action to preserve a card.
- Create global horizontal scrolling.
- Choose breakpoints by device model without testing content.

## False authorship signals

Reject inferences such as:

- “it uses cards, so AI made it”;
- “it uses dark mode/cyan/serif/mono, so AI made it”;
- “it has a three-dot menu, so AI made it”;
- “it is polished or symmetrical, so AI made it”;
- “it has a bug, so it was generated”;
- “it follows a design system, so it is not original.”

Report only the observable effect and evidence: generic pattern, decision without functional rationale, inconsistency, accessibility, visual maintainability, or preference.

## Critique questions

1. Could this belong to any product in the same category without alteration?
2. Does it exist because of content/task or because the component was available?
3. Does the hierarchy remain clear without effects, borders, and cards?
4. Is the content representative or authoritative, does it identify fixtures and cover extreme states without exposing sensitive data?
5. Does the interaction work with keyboard, touch, and assistive technology?
6. Does mobile reprioritize or merely stack?
7. Does the rule come from the project, a normative requirement, guidance, or taste?
