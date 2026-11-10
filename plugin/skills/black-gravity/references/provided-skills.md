# Skills for the delegate

Reference for the [core skill](../SKILL.md). Open it when passing `skills` to the delegate or on `CRAFT_SNAPSHOT_INVALID` or `CRAFT_SNAPSHOT_MISSING`.

## Providing skills to Gemini

When the user asks for a skill in the delegation, read its definition and the needed resources and provide only the selected packages in `black_gravity_run.skills`: `[{ name, content, resources?: [{ path, content }] }]`. `content` is the full text of `SKILL.md`; each resource uses a path relative to the skill folder and UTF-8 content. Do not import every global skill or send private instructions, credentials or internal documents. Dependencies on Codex connectors or tools do not come to exist in agy just because the skill was copied.

The bridge keeps the name and content, prepares the files in `.agents/skills/<nome-em-minúsculas>/` in the copy and asks the CLI to load them. Up to 8 packages, 100 resources per skill and 1 MiB in total, also subject to the copy limits. The `providedSkills` metadata returns names and hashes; in compact mode, `providedSkillSummaries` reports names, hashes and counts without long file lists. Resuming keeps these files; do not pass `skills` again. Changes to the packages block verification/integration. The helpers are not integrated into the original and do not widen permissions.

## Included Anti-AI Craft

In new tasks, the bridge automatically prepares `anti-ai-code` and `anti-ai-security` and offers the other Anti-AI Craft skills as a read-only catalog; do not send them again in `skills` or ask the user to repeat the names. They take two of the eight package slots. Check `task.craft` (revision, permanent skills and catalog). `CRAFT_SNAPSHOT_INVALID` or `CRAFT_SNAPSHOT_MISSING` indicate a tampered or incomplete installation: tell the user to reinstall the bridge, without downloading another revision. A statement by Gemini that it read a skill does not prove the reading; check the tool events when the evidence matters.
