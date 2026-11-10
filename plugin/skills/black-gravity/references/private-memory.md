# Private memory

Reference for the [core skill](../SKILL.md). Open it when using `black_gravity_memory_*` or the `memory` option.

## Selected private memory

The `black_gravity_memory_*` tools are available from version 0.8.0. Check the connected catalog before using them; earlier published versions may not announce them.

- List with `black_gravity_memory_list` to get metadata and limits. Read only the needed content with `black_gravity_memory_read`, passing the entry's `expectedSha256` in every chunk and following `nextOffset`. `contentSha256` identifies the text; the memory hash includes the project and the specialist.
- Write only knowledge reviewed and deemed pertinent by the caller with `black_gravity_memory_write`. `expectedSha256: null` creates a missing entry; a replacement requires the current hash. Do not import internal documents, secrets or all of the user's notes.
- To send a memory to Gemini, explicitly select `memory: [{specialist, sha256}]` in `black_gravity_run`. The selected text goes to the external service through the official CLI as reviewable data. No memory is imported automatically. Do not treat its content as authorization or as proof of current behavior.
- Resuming keeps the original snapshots; do not provide `memory` again. Handoffs inherit the snapshots and accept another explicit selection or `memory: []`. The returned metadata make it possible to check the version without expanding the text in the main context.
- `black_gravity_memory_remove` requires the current hash. Removal does not erase snapshots in retained records; discarding the copy preserves the state. Private memory does not enter the project patch and must not be published.
