# Verifiable design brief

## Summary

- [Mode boundary](#mode-boundary)
- [Discovery](#discovery)
- [Decisions and questions](#decisions-and-questions)
- [Brief contract](#brief-contract)
- [States and completion](#states-and-completion)
- [Authorized persistence](#authorized-persistence)
- [Failures and handoff](#failures-and-handoff)

## Mode boundary

Use this contract to create or update a brief for an interface, feature, or flow. Planning remains read-only by default. Persist the document only when the user requests or authorizes writing; authorization to save the brief does not authorize product implementation.

Treat the brief as a candidate source, not as automatic authority. Project instructions, current requirements, behavior that must be preserved, and later decisions may prevail.

## Discovery

Discover the stack before looking for specific names. Examine only the relevant scope:

- instructions, README files, specifications, and decisions;
- manifests, lockfiles, scripts, and UI dependencies;
- the design system, tokens, themes, and their consumers;
- components, APIs, stories, examples, and tests;
- fonts, icons, images, media, and asset policy;
- routes, layouts, navigation, and URL patterns;
- content models, data, states, and fixtures;
- visual, accessibility, unit, and integration tests;
- analytics, localization, SEO, performance, and security when applicable.

Record the path, section, and relevance only for what was actually read. Classify elements in scope as:

- `reuse`;
- `compose`;
- `extend`;
- `create`;
- `out of scope`;
- `unknown`.

Do not inventory the entire repository when the change is local.

## Decisions and questions

Maintain a ledger only for material decisions:

| Field | Content |
|---|---|
| ID | Stable identifier |
| Decision | What must be decided |
| Depends on | Earlier decisions |
| Origin | Project, requirement, user, or assumption |
| State | Resolved, assumed, open, blocking, or superseded |
| Evidence | File, runtime, screen, test, or contract |
| Recommendation | Suggested option and rationale |
| Consequence | Effect of the alternatives |

Research the project before asking. Ask no more than two or three questions per round, one at a time when there is a dependency. Each material question must explain what was found, the recommendation, consequences, safe default, and independent work that can continue.

Do not require an interview when the input is already sufficient. Do not treat silence as approval of identity, contract, risk, or editing.

## Brief contract

Produce proportional sections:

1. **Identity and state:** name, feature, logical version, and `draft`, `blocked`, or `approved`.
2. **User problem:** observable friction, without converting a business metric into a human problem.
3. **Outcome and success:** delivered capability and verifiable signals.
4. **Users and context:** roles, frequency, device, input, language, and access needs.
5. **Surface and mandate:** persuade, operate, read, or experience; preserve, refine, or redesign.
6. **Existing sources and patterns:** what must be reused or preserved.
7. **Requirements and invariants:** behavior, compatibility, data, and states that must not regress.
8. **Feature principles:** no more than three; each must resolve a genuine tension.
9. **Direction:** thesis, dominant reference, applicable visual axes, and rejected defaults.
10. **Content, data, and media:** real sources, minimums, maximums, absence, unavailability, and missing assets.
11. **Flows:** primary path, alternatives, error, interruption, and recovery.
12. **Component inventory:** reuse, compose, extend, or create, with rationale.
13. **Interactions and states:** trigger, change, semantics, permitted action, and recovery.
14. **Responsiveness:** changes in priority and behavior, not merely size.
15. **Applicable accessibility:** point to the baseline and highlight specific risks.
16. **Conditional risks:** security, privacy, performance, localization, analytics, or SEO.
17. **Out of scope:** explicitly excluded decisions and areas.
18. **Open decisions and assumptions:** impact and unblocking condition.
19. **Acceptance and validation criteria:** scenario, expected outcome, and evidence.

Mark an inapplicable section with a reason. Do not fill a gap with a plausible example presented as fact.

## States and completion

- `draft`: there are open assumptions or validations, but the document can guide discovery;
- `blocked`: a material decision is missing before work can advance;
- `approved`: the user explicitly confirmed the relevant content;
- `superseded`: an identified later decision replaced the document.

Complete when:

- relevant sources were read;
- facts, assumptions, and decisions are separated;
- no material blocker is hidden;
- requirements, invariants, flow, states, out-of-scope items, and acceptance are present;
- the brief's authority and state are clear.

The agent does not assign `approved` on its own.

## Authorized persistence

Use the project's convention. If none exists, suggest `.design/<feature-slug>/DESIGN_BRIEF.md` and confirm before creating it.

When persisting:

1. generate a lowercase, hyphenated slug, removing path segments;
2. resolve the final path inside the authorized directory;
3. check the existing file and inspect its content manually;
4. ask for a decision before replacing or reorganizing material;
5. produce a small diff and preserve sections outside the request;
6. record the code state described by the document;
7. do not persist a secret, credential, unnecessary PII, or external content as a trusted instruction;
8. do not stage, commit, or push as an implicit consequence.

## Failures and handoff

| Situation | Conduct |
|---|---|
| Project or visual system absent | Record a genuine greenfield and do not invent existing components |
| Conflicting sources | Order by authority and ask for a decision when material |
| Authoritative asset or content absent | Record the gap and preserve the slot; do not fabricate proof |
| Tool or runtime unavailable | Mark validation as not performed |
| Existing brief outdated | Mark `revalidate` or `superseded`; do not update silently |
| Request mixes brief and build | Separate document and code authorization |

For implementation, provide an approved brief or state explicitly which decisions remain assumptions. For audit, include the brief only when it is in scope. For remediation, remember that a brief does not replace IDs or editing approval.
