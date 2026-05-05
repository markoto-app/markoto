---
title: Two writers, one document
description: Live co-editing — cursors, selections, and edits broadcast in real-time, no save button.
category: workspaces
order: 4
---

# Two writers, one document

When two people open the same doc, they see each other's cursors,
each other's selections, and each other's edits land character by
character. There's no save button, no merge dialog, no conflict
resolution prompt. It just works.

::flow{id="two-writers-one-document" hide-title}
::

## What just happened

Every doc is backed by a Y.js CRDT. Each editor is a Y.js client
connected via WebSocket to the Hocuspocus sync server. Edits are
broadcast as Y.js update messages and merged deterministically — the
same edit applied in any order produces the same final state.

The PresenceBar at the top shows who's currently editing; the colored
cursors in the doc come from Y.js awareness; the per-stripe author
colors come from a 15-color desaturated palette in `app/utils/colors.ts`
(no human ever wears the AI's vermillion).

Behind the scenes: the Y.js state lives in Postgres via `y-postgresql`,
so a server restart doesn't lose work, and a client that goes offline
and reconnects gets caught up automatically.

## What's next

- [See what changed](/docs/history/see-changes) — every edit is a row in the activity log.
- [Have a discussion in your document](/docs/writing/comments) — comment on a passage your collaborator just wrote.
