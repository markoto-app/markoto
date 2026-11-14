---
title: Restore an earlier version
description: One click rolls the doc back to that version. The restore is itself an undoable activity row.
category: import-export
order: 5
featured: true
updated: '2026-11-04'
---

# Restore an earlier version

Click any past activity row and press Restore. The doc rolls back to
that exact state: title, content and theme. Your collaborators see the rollback live. The
restore is itself a tracked activity row, so you can restore back
to "before the restore" if you change your mind.

::flow{id="restore-an-earlier-version" hide-title}
::

## What just happened

markoto rewinds the document to the version you picked and everyone in
the document sees the rollback immediately. The restore is recorded
under your name in the activity log like any other change.

A restore either happens completely or not at all: if something goes
wrong, the document stays as it was and you see an error.

You need edit access to restore; viewers can browse the history but not
roll it back.

## What's next

- [See the diff before you restore](/docs/import-export/see-changes): preview what restore would change.
- [Replay a comment in its original context](/docs/collaborate/comment-replay): for non-destructive looking-back.
