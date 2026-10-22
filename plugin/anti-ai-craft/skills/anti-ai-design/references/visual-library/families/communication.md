# Communication

Conversation and coordination surfaces where authorship, sequence, reply structure, presence, and shared context organize interaction.

**Usually appropriate for:** Messaging, comments, reviews, group coordination, and asynchronous discussion.

**Frequent errors:** Flattening threads; separating discussion from its object; turning every message into a decorative card.

**Do not use by default for:** One-way publication, structured records better served by fields, or urgent systems requiring acknowledged alerts.

**Products represented:** Element, Excalidraw, GitHub, Mattermost, Penpot, Zulip.

This is a textual index. Open only the source or local image for the few references selected for the current task.

| ID | Product | Screen | Mini summary | When to consult | Main characteristic | Theme | Image or source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VR-005 | GitHub | Review suggestion — contextual feedback composer | It demonstrates communication shaped by code-review state and evidence instead of a universal comment component. | Too heavy for casual chat, simple reactions, or feedback that cannot safely be represented as a patch. | Keep feedback format tools and submission-state choices adjacent to the content they govern, with labels that expose lifecycle di… | light | [local image](../images/github/suggestion-block.png) |
| VR-020 | Penpot | Review inbox — comments grouped by artifact | It gives a concrete, legible example of how triage review comments across multiple design files. The structure is justified by the domain rather than… | Synchronous conversation with no persistent review object. | A comment inbox groups authorship and excerpt by source artifact before opening the canvas. | light | [local image](../images/penpot/vr-020-comments-dashboard.png) |
| VR-021 | Penpot | Anchored review thread beside the canvas | It gives a concrete, legible example of how discuss a selected design location without losing spatial context. The structure is justified by the doma… | Long-form deliberation that needs a standalone document. | Numbered anchors, thread history, reply composer, and canvas coexist in a split workspace. | mixed | [local image](../images/penpot/vr-021-comments-thread.png) |
| VR-024 | Zulip | Channels and topics — two-level conversation model | It gives a concrete, legible example of how navigate active conversations without flattening every message into one stream. The structure is justifie… | One-to-one chat or discussion without stable subjects. | A channel/topic hierarchy places messages under durable subjects and exposes unread counts at both levels. | light | [local image](../images/zulip/vr-024-channels-and-topics.png) |
| VR-030 | Mattermost | Desktop channel — navigation, thread, and composer | It gives a concrete, legible example of how follow team discussion across channels while composing in context. The structure is justified by the doma… | A structured case record better served by fields and workflow state. | Workspace, channel list, chronological messages, pinned context, and composer form a stable communication shell. | dark | [local image](../images/mattermost/vr-030-main-window.png) |
| VR-032 | Mattermost | Channel with contextual thread pane | It gives a concrete, legible example of how read a channel and resolve a side conversation without leaving it. The structure is justified by the doma… | Independent documents or unrelated conversations. | The main chronology and selected thread remain adjacent, preserving parent context and reply depth. | light | [local image](../images/mattermost/vr-032-channels-hero.png) |
| VR-078 | Excalidraw | Live collaboration setup — session before canvas | It gives a concrete, legible example of how start or stop a private shared drawing session. The structure is justified by the domain rather than by a… | Asynchronous review requiring durable anchored threads. | Session URL, identity, privacy explanation, and termination action precede collaborative editing. | light | [local image](../images/excalidraw/vr-078-collaboration.png) |
| VR-082 | Element | Invite to room — identity-aware recipient command | It gives a concrete, legible example of how invite a known person or identifier into a conversation space. The structure is justified by the domain r… | Bulk directory administration across many rooms. | A focused dialog preserves room context, identity-server caveat, selected recipient, and one consequential action. | light | [local image](../images/element/vr-082-invite-dialog-room-with-user-pill-linux.png) |
