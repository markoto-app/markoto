---
title: Delete a document
description: Owner-only. Immediate. Irreversible. The doc, its history, its uploads, all of it.
category: account
order: 4
---

# Delete a document

Doc deletion is the simplest destructive action in markoto. The owner
hits Delete, confirms once, and the doc is gone — content, Y.js
history, image uploads, activity log, comments. There is no trash, no
undo, no recovery. (If you might want it back later, [duplicate
it](/docs/writing/duplicate) before deleting, or
[export the workspace](/docs/account/data-export) for a frozen
snapshot.)

::flow{id="delete-a-document" hide-title}
::

## What just happened

`DELETE /api/docs/:id` runs `deleteDocument()` which removes:

- The `documents` row
- The `yjs_documents` history rows (full Y.js state)
- All `uploads` rows + their S3 objects under `docs/{docId}/`
- The `comments` rows attached to the doc
- The `activity_log` rows for the doc (auto-cascaded by FK)
- Any cached PDF/PNG renders under `renders/{docId}/`

For docs that live in a workspace, admins can delete any doc; editors
can only delete their own. Anonymous docs (no owner) are deletable by
anyone with edit access — which is most people, since anonymous docs
default to open-edit. (That's the cost of frictionless anonymous
editing; if you don't want it, sign in.)

## What's next

- [Duplicate first, delete second](/docs/writing/duplicate) — for "I want a fresh copy without this one cluttering the list".
- [Delete your account](/docs/account/delete-account) — for cleaning up everything at once.
