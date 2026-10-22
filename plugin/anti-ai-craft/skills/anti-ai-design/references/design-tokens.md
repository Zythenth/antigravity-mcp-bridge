# Operational design tokens

## Summary

- [Principle](#principle)
- [Discovery and classification](#discovery-and-classification)
- [Source, aliases, and consumers](#source-aliases-and-consumers)
- [Families](#families)
- [Modes and themes](#modes-and-themes)
- [Implementation and validation](#implementation-and-validation)
- [Output contract](#output-contract)

## Principle

Organize the `primitive → semantic → component or consumer` chain when the project adopts these layers. Create only abstractions and families with genuine intent and consumers. A catalog of variables without connected use, states, or modes does not constitute a complete system.

Do not require CSS, a framework, dark theme, scale, breakpoint, token count, or format.

## Discovery and classification

Discover:

- definitions, imports, and consumers of variables;
- theme configuration, providers, attributes, and preferences;
- native platform objects or resources;
- structured files and generation scripts;
- component libraries and documentation;
- repeated or hardcoded values;
- aliases, references, and generated outputs;
- visual tests and design tools;
- brands, themes, densities, or platforms.

Classify the system as:

- `nonexistent`;
- `informal`: repeated values without stable semantics;
- `partial`: some layers or generation;
- `established`: source, layers, and consumers identified;
- `fragmented`: competing sources or duplicated policy.

The classification determines whether to `create`, `extend`, `consolidate`, `connect consumers`, or `preserve`.

## Source, aliases, and consumers

1. Identify the authoritative source through documentation, imports, scripts, and consumers—not by a file's name or date.
2. Distinguish derived files and the official generation command.
3. Resolve aliases and dependencies; look for a missing reference, cycle, or incompatible type or unit.
4. Map tokens to representative consumers, states, and modes.
5. Change the smallest layer capable of expressing the intent.
6. Regenerate outputs with the official command.
7. Remove only proven orphans or those created by the change.

Treat as a technical candidate:

- broken or circular alias;
- divergent source and output;
- primitive consumed where the contract requires a semantic token;
- hardcoding that bypasses current policy;
- manual theme branch that duplicates a provider;
- orphaned token;
- textual replacement without confirmed semantics.

A local literal is not a failure by itself. Intrinsic, calculated, media, or third-party values may remain local with justification.

## Families

Create only applicable families. For each token, record intent, name, type/unit, consumer, states, modes, and validation.

### Color

Map the necessary roles:

- surfaces and backgrounds;
- text and icons;
- borders and separators;
- action, focus, and interaction;
- success, warning, error, and information;
- overlay and elevation.

Value names belong to the primitive layer; the semantic API expresses intent. Do not communicate state through color alone.

### Typography

Define roles for reading, display, data, and code. Treat family, fallback, size, weight, line height, and tracking as a set. Validate language, supported scripts, zoom, text spacing, translation, and long strings.

Do not impose a number of families, steps, or weights.

### Spacing, dimension, shape, and elevation

- Extend the existing scale.
- Derive steps from real grouping, density, touch, and layout.
- Avoid near-duplicates without a function.
- Allow a justified local exception.
- Do not tokenize media proportions or intrinsic calculations merely for completeness.
- Connect radius and shadow to shape, state, or elevation.

### Motion

Tokenize duration, easing, delay, or intensity only when they represent repeated language. Record the consumer, state transition, and reduced variant. Do not create a scale for a one-off animation or adopt a universal bounce or duration.

### Layout and breakpoints

Define breakpoints when content, reading, navigation, or interaction stops working. Respect the stack's capabilities; do not treat device classes as a universal contract.

## Modes and themes

Preserve the existing mechanism. Create a new mode only by requirement and authorization.

When there are multiple themes or modes, record:

- source of truth;
- modes actually supported;
- precedence among system, product, and manual choice;
- persistence and pre-hydration state;
- parity of semantic roles;
- assets, native controls, overlays, and shadows;
- contrast, focus, states, and forced colors;
- relationship to reduced motion.

Do not combine competing providers, attributes, and media queries without an explicit contract.

## Implementation and validation

Before:

- record the baseline and consumers;
- bound reach by components, brands, modes, and platforms;
- request approval when a global token or pipeline has broad reach;
- anticipate rollback or migration.

After:

1. validate aliases, types, and generation;
2. run the relevant official build/lint/tests;
3. compare representative consumers with the same data and states;
4. cover affected modes, interaction, contrast, zoom, long strings, and reduced motion;
5. review the source and output diff;
6. record untested combinations.

A build does not prove the visual result; a screenshot does not prove chain integrity.

## Output contract

Deliver:

- system classification;
- authoritative source and generated outputs;
- formats and commands;
- applicable modes and families;
- preserved, added, changed, and rejected tokens;
- affected aliases and consumers;
- values that still bypass the chain;
- reach and approval;
- visual and technical validations;
- risks, out-of-scope debt, and pending decisions.
