# Accessibility baseline

## Summary

- [Authority](#authority)
- [Semantics and structure](#semantics-and-structure)
- [Keyboard and focus](#keyboard-and-focus)
- [Menus and overflow](#menus-and-overflow)
- [Modals](#modals)
- [Tabs](#tabs)
- [Forms and errors](#forms-and-errors)
- [States and messages](#states-and-messages)
- [Contrast, color, and targets](#contrast-color-and-targets)
- [Reflow, zoom, and text](#reflow-zoom-and-text)
- [Motion](#motion)
- [Minimum manual matrix](#minimum-manual-matrix)
- [Validation by slice and on mobile](#validation-by-slice-and-on-mobile)

## Authority

Use applicable WCAG 2.2 A/AA as the normative baseline for the web. Treat WAI-ARIA APG, GOV.UK, Carbon, Material, Fluent, Apple HIG, Xbox XAG, MDN, and NN/g as guidance or heuristics. Prefer native HTML. Test ARIA patterns with the actual browser and assistive-technology combinations.

## Semantics and structure

- Preserve reading, DOM, and focus order.
- Use landmarks, headings, lists, tables, links, buttons, and fields according to their purpose.
- Expose name, role, value, state, and relationships.
- Make the accessible name contain the visible text.
- Do not communicate information through color, position, shape, or motion alone.

## Keyboard and focus

- Make all functionality keyboard-operable without specific timing.
- Avoid positive tabindex values.
- Keep focus visible, logical, and not entirely obscured.
- Do not move focus during an ordinary update.
- After removing a trigger, move focus to the next logical point.
- Test Tab, Shift+Tab, Enter, Space, arrow keys, Home, End, and Escape as appropriate to the widget.

## Menus and overflow

- Use a button as the trigger, with a name and expanded state.
- On open, move focus according to the selected pattern.
- Navigate items with arrow keys; activate by keyboard; close with Escape.
- Return focus to the trigger or logical context.
- Preserve a touch and voice alternative; do not depend on hover.
- Keep primary/frequent actions outside overflow.

## Modals

- Provide a title/name and a visible close control.
- Make the background genuinely inert.
- Set initial focus according to the task.
- Contain Tab and Shift+Tab.
- Close an ordinary dialog with Escape.
- Return focus to the invoker or next logical point.
- Prefer the least destructive action as initial focus in an irreversible confirmation.

## Tabs

- Associate each tab with its tabpanel.
- Keep only the active tab in the Tab sequence.
- Use arrow keys for internal navigation.
- Use automatic activation only when there is no perceptible latency; otherwise, use manual activation.
- Do not wrap tabs across multiple lines without an accessible pattern.

## Forms and errors

- Provide a persistent, associated label.
- Do not use a placeholder as a label.
- Associate hints and errors with the field.
- Identify the error in text and suggest a correction when known.
- Preserve data and allow pasting/password managers.
- In long forms, combine inline messages with a navigable summary.
- For consequential operations, offer appropriate reversal, review, or confirmation.

## States and messages

- Expose selected, checked, expanded, disabled, read-only, busy, and invalid programmatically.
- Explain unavailability when necessary; disabled is not an explanation.
- Announce status without moving focus.
- Reserve alert/assertive for genuine urgency.
- Do not announce an entire page or history as an update.

## Contrast, color, and targets

- Normal text: 4.5:1; large text: 3:1.
- Components and essential indicators: 3:1.
- Visible focus must survive themes and forced colors.
- WCAG 2.2 AA minimum target: 24×24 CSS px or a normative exception.
- Use the platform/product's larger target for frequent actions and mobile.
- Do not treat dp, pt, and CSS px as equivalent units.

## Reflow, zoom, and text

- Test reflow at 320 CSS px without two-dimensional scrolling, except for essentially two-dimensional content.
- Test text at 200% and zoom at 400% when applicable.
- Test text-spacing overrides, long strings, translation, and RTL.
- Allow local overflow for genuine tables/maps while preserving headers and context.

## Motion

- Allow users to pause, stop, or hide automatic content when WCAG requires it.
- Do not exceed flash thresholds.
- Respect prefers-reduced-motion and native preferences.
- Replace intense motion with a static or subtle alternative.
- Do not use motion as the only feedback.

## Minimum manual matrix

This is a selection matrix, not a universal list. Choose only the dimensions
applicable to the widget, flow, risk, platform, and actual support; record the rest as `not
applicable` or `not exercised`, with a reason.

1. For operable flows, traverse the primary and recovery paths by keyboard.
2. For a changed menu, modal, tabs, or drawer, record focus before/after and the corresponding commands.
3. For semantics or dynamic updates, verify a screen reader in the supported combination.
4. For responsive scope, test representative viewports defined by the project or risk.
5. For content that must reflow, test 320 CSS px, 200%, 400%, text spacing, and long strings according to the applicable criterion.
6. For affected color, theme, or system styles, verify contrast and the modes actually supported, including forced colors when applicable.
7. For touch surfaces, test targets and touch operation.
8. For introduced or changed motion, test reduced motion.
9. For states present in scope, exercise relevant empty, loading, error, offline, permission, and extreme-data states.
10. When compatible accessibility automation is available, run it without treating it as a replacement for the selected manual passes.

## Validation by slice and on mobile

- Attach to each interactive slice only the checks for semantics, keyboard, focus, messages, and state that it introduces or changes; retain an integrated flow pass at the end.
- On reading surfaces, verify line measure, rhythm, and continuity in the relevant viewports without turning editorial preference into a norm.
- In mobile forms, test focus, browser zoom, the virtual keyboard, safe area, clipping, scrolling, and access to the primary action.
- Record browser, viewport, input, and state; separate normative failure from a usability issue or preference.
