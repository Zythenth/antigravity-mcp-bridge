# Visual reference library

This is a progressive-disclosure catalog of 100 inspected interfaces from real products. It is visual, structural, heuristic, and non-normative. It exists to broaden the set of structures the skill can recognize, not to establish an Anti-AI aesthetic or make any product a default model.

Esta biblioteca é inspiração visual e estrutural não normativa. Ela não substitui requisitos, design system do projeto, acessibilidade, pesquisa com usuários ou fontes de verdade.

The collection is deliberately separate from `../sources.md`. A screenshot demonstrates that a product used a structure; it does not prove that the structure is universally effective or preferable.

## Use the collection progressively

Do not load all 100 references or all family indexes into one task.

1. Identify the problem: user outcome, domain objects, constraints, and source of truth.
2. Identify the surface: browse, operate, edit, configure, communicate, learn, or onboard.
3. Describe the task, domain, expected density, interaction type, relevant state, and visual need.
4. Select one family below from that description, not from an aesthetic preference.
5. Open that family's textual index and filter by task, structure, surface, theme, and `inappropriate_context`.
6. Inspect only a small shortlist in `catalog.jsonl`, then open only the source or local image for candidates that still fit.
7. Lock one dominant reference for composition and structural language.
8. Add at most the few secondary references that are necessary. Give each a narrow, explicit role such as density, interaction, motion, or content treatment.
9. State what is being learned from every selected reference and what will not be copied: brand, exact palette, proprietary content, trademarked form, or a composition unrelated to the current domain.
10. Implement the structural logic in the current product's design system and validate that the result still belongs to its own domain.

If sources conflict, resolve the conflict from the task and constraints. Never calculate a visual average. Record the exact IDs and screens actually consulted instead of citing the whole library.

The governing order remains:

```text
domain → task → content → state → structure → visual language
```

Theme is one filter, not a quality score. The catalog intentionally contains strong dark-mode coverage, but dark mode must not be selected without a product requirement, user preference, system behavior, or contextual reason.

## Family router

| Family | Start here when the primary need is… | Typical structures |
| --- | --- | --- |
| [Dense professional](families/dense-professional.md) | repeated comparison and frequent operational action | tables, queues, matrices, multi-panel workspaces |
| [Command / keyboard-first](families/command-keyboard-first.md) | fast invocation with minimal pointer travel | command palettes, ranked search, action menus |
| [Canvas / spatial](families/canvas-spatial.md) | direct manipulation of position, sequence, or connections | canvases, timelines, node graphs, boards |
| [Document-centric](families/document-centric.md) | reading, writing, or contextual detail around one artifact | editors, records, threads, experiment briefs |
| [Industrial / tool-like](families/industrial-tool-like.md) | precise configuration, diagnosis, or control | inspectors, rule builders, device panels, failure stages |
| [Expressive / playful](families/expressive-playful.md) | identity, progress, media, or delight grounded in the domain | libraries, learning paths, profiles, ambient status |
| [Technical / developer](families/technical-developer.md) | evidence, code, runtime state, or system relationships | diffs, traces, logs, debuggers, token inspectors |
| [Communication](families/communication.md) | conversation attached to an object, event, or decision | comments, event timelines, task discussions, assistant panels |
| [Content / catalog](families/content-catalog.md) | discovery across a collection | stores, libraries, taxonomies, faceted browsers |
| [Minimal / utilitarian](families/minimal-utilitarian.md) | one short action or a very small decision surface | setup forms, focused settings, empty states, calculators |

## Catalog fields

Each JSON Lines record is independently readable and includes the task, structural rationale, domain relationship, what a generic dashboard would lose, reusable and product-specific decisions, anti-patterns countered, inappropriate contexts, source and rights assessment, dimensions, exact and perceptual hashes, and the completed validation checklist.

- Every main-catalog record has an `image_path`; all 100 references are locally versioned from sources with an explicit redistribution basis.
- `image_url` may identify the inspected official asset, but it is not permission to redistribute it.
- `license_id`, `license_url`, `license_notes`, and [ATTRIBUTIONS.md](ATTRIBUTIONS.md) record the applicable terms and credit.
- `research_sha256` and `perceptual_hash` describe the inspected source asset.
- `redistribution_status` in the public catalog is either `redistributable` or `attribution-required`.

Earlier proprietary/link-only research is excluded from the 100-item count and summarized in `research/superseded-link-only-summary.jsonl`. Its images are not versioned. Research-only candidate downloads remain Git-ignored in `research/.cache/`.

## Maintenance and validation

Research state is persisted in `research/progress.json`; rejected candidates are recorded in `research/rejected.jsonl`; the legal-first ten-item checks live in `research/checkpoints.jsonl`.

Run:

```powershell
python plugins/anti-ai-craft/skills/anti-ai-design/references/visual-library/research/validate_catalog.py
python plugins/anti-ai-craft/skills/anti-ai-design/references/visual-library/research/generate_family_indexes.py
```

The validator checks the exact 100 IDs, schema completeness, family quotas, the 55–60 dark-mode constraint, at least 15 represented products, the six-reference product cap, local files, license fields, SHA-256 duplication, and dHash near-duplicate candidates. Human review remains required for perceptual warnings and for every licensing judgment.
