---
title: Restore an earlier version
description: One click rolls the doc back to that version — the restore is itself an undoable activity row.
category: history
order: 2
featured: true
---

# Restore an earlier version

Restore is an honest "rewind". Click any past activity row, hit
Restore, the doc rolls back to that exact state — title, content,
theme, all of it. Your collaborators see the rollback live. The
restore is itself a tracked activity row, so you can restore back
to "before the restore" if you change your mind.

::flow{id="restore-an-earlier-version" hide-title}
::

## What just happened

Restore acquires a Postgres advisory lock on the doc id (so two
concurrent restore attempts can't race), replays the Y.js state
to the target snapshot id, then connects a synthetic Hocuspocus
client that broadcasts the restored state to all live editors. The
synthetic client uses the restorer's identity so the activity row
attributes correctly.

The atomic-failure guarantee: if any step fails, the lock is released,
the doc is unchanged, and the user sees an error. Half-applied restores
are not possible.

Edit access required (not just view) — restore is a content mutation.

## What's next

- [See the diff before you restore](/docs/history/see-changes) — preview what restore would change.
- [Replay a comment in its original context](/docs/writing/comment-replay) — for non-destructive looking-back.
