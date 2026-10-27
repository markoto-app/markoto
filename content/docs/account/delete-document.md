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

Deleting a document removes:

- The document itself and its full edit history
- All uploaded images (and AI-generated ones)
- Its comments
- Its activity log
- Any cached PDF and page renders

For docs that live in a workspace, admins can delete any doc; editors
can only delete their own.

Anonymous docs (created without signing in) can be deleted only from
the browser that created them: markoto remembers that browser with a
small cookie. Anyone with the link can still edit an anonymous doc
(they're open-edit by default), but they can't delete it. If you clear
your cookies or switch browsers, you can no longer delete the doc
yourself; unused anonymous docs are cleaned up automatically after a
long period of inactivity. To keep full control over a doc, sign in
before you create it.

## What's next

- [Duplicate first, delete second](/docs/writing/duplicate) — for "I want a fresh copy without this one cluttering the list".
- [Delete your account](/docs/account/delete-account) — for cleaning up everything at once.
