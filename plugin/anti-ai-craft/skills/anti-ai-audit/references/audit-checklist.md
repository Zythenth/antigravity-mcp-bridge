# Audit checklist

## Summary

- [Scope and sources of truth](#scope-and-sources-of-truth)
- [Ledger and closure](#ledger-and-closure)
- [Interface and experience](#interface-and-experience)
- [Accessibility](#accessibility)
- [Code and behavior](#code-and-behavior)
- [Architecture and maintainability](#architecture-and-maintainability)
- [Tests and documentation](#tests-and-documentation)
- [Classification](#classification)
- [Evidence by family](#evidence-by-family)

## Scope and sources of truth

- [ ] Target type, root, scope, objective, authorization, and no-editing constraint confirmed.
- [ ] Instructions, README, specification, design/code guides, and configs read.
- [ ] If Git exists, branch, HEAD, status, pre-existing changes, upstream/target, and exact `merge-base` are recorded; outside Git, the fields are marked as not applicable.
- [ ] The baseline was not assumed to be `main`, `HEAD^`, or the previous commit; the SHA and command used for the diff were recorded.
- [ ] In a diff, introduced/worsened items are separated from pre-existing technical debt.
- [ ] Users, tasks, data, states, and invariants identified.
- [ ] Relevant flow artifacts have their status, authority, whether they are current, and their relationship to the code verified.
- [ ] Official commands and environment known.
- [ ] Commands that would write caches, snapshots, lockfiles, databases, or artifacts to the target were avoided.

## Ledger and closure

- [ ] Every candidate has an ID, location, family, validation method, examined control, and disposition.
- [ ] Disposition is confirmed, suppressed, not applicable, depends on infrastructure, unverified, or duplicate.
- [ ] Strongest disconfirming evidence and evidence gap are recorded.
- [ ] Environment/setup failure was not used as disconfirming evidence.
- [ ] A safe adjacent path did not suppress an independent instance.
- [ ] Duplicates share cause/control, behavior, impact, and fix.
- [ ] The audit continued across the entire scope after the first finding; any cutoff is recorded as an unaudited area.

## Interface and experience

- [ ] The primary task and hierarchy match the product.
- [ ] Composition, density, cards, bento, sidebar, topbar, and hero have a function.
- [ ] Tables, lists, forms, modals, tabs, menus, and search use an appropriate form.
- [ ] Kebab menus contain only coherent secondary actions; primary actions remain visible.
- [ ] Content, microcopy, data, and states are real.
- [ ] Typography, color, shadow, border, radius, icons, and motion have roles.
- [ ] Desktop, tablet, and mobile reprioritize correctly.
- [ ] Before/after views or actual screenshots were compared when available.
- [ ] The evidence profile and surface/route × state × viewport × theme/input matrix are recorded in proportion to the risk.
- [ ] The surface map, role-based navigation, deep links, URLs/redirects, return paths, growth, and persistence were exercised when applicable.
- [ ] Visual duplication or proposed reuse was validated against the actual component, API, reach, and limitations; no inference based only on appearance.
- [ ] The authoritative token source, generated outputs, layers, aliases, consumers, hardcodes, and parity across modes/states were examined when tokens were in scope.

## Accessibility

- [ ] Semantics, name, role, value, and state.
- [ ] Keyboard, focus, Escape, and focus return.
- [ ] Complete modal, tabs, menu, and tooltip behavior.
- [ ] Labels, errors, and form recovery.
- [ ] Contrast, non-exclusive use of color, and forced colors.
- [ ] Targets, reflow at 320 CSS px, 200%, 400%, and text spacing.
- [ ] Reduced motion and automatic content.
- [ ] Status/live regions without noise.

## Code and behavior

- [ ] Requirements/invariants linked to executable paths.
- [ ] APIs, imports, dependencies, and configuration exist.
- [ ] No false success, swallowed error, or hidden fallback.
- [ ] Validation, authentication, and authorization are correct.
- [ ] Mutation, transaction, rollback, and idempotency.
- [ ] Concurrency, async, cancellation, timeout, and listeners.
- [ ] Impossible state and magic values.
- [ ] Secrets, absolute paths, and sensitive data.
- [ ] Performance, caching, and logging have supporting evidence or a need.
- [ ] Evidence forms input/executable path → violated invariant → observable outcome.

## Architecture and maintainability

- [ ] Local architecture and patterns preserved.
- [ ] Wrappers/helpers/factories/interfaces add value.
- [ ] No premature abstraction or excessive configuration.
- [ ] No dozens of small files without benefit.
- [ ] Duplication, dead code, and speculative compatibility evaluated.
- [ ] Public API does not change silently.
- [ ] Comments/docstrings do not repeat or make promises without evidence.

## Tests and documentation

- [ ] The regression test reproduces the problem.
- [ ] Happy path and relevant failures/limits.
- [ ] Mocks do not confirm themselves.
- [ ] Snapshots are small and semantically reviewed.
- [ ] Integration covers relevant wiring/config/serialization/transaction behavior.
- [ ] Commands actually executed and results recorded.
- [ ] Documentation does not promise a nonexistent feature.

## Classification

- [ ] Confirmed bug.
- [ ] Accessibility.
- [ ] Security.
- [ ] Maintainability.
- [ ] Contextual generic appearance.
- [ ] Inconsistency.
- [ ] Pending decision.
- [ ] Subjective preference.
- [ ] Rejected false positive.

## Evidence by family

- [ ] Correctness: input/executable path → invariant → observable outcome.
- [ ] Security: controllable source → nearest control → sink/operation → preconditions → impact.
- [ ] Accessibility: action/state → expected semantics/operation → observed failure.
- [ ] Design: task → action/hierarchy → viewport/state → concrete harm.
- [ ] Design flow: decision/requirement → current artifact → implementation/runtime → evidence/disposition.
