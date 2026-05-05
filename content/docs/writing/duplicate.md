---
title: Duplicate a document
description: One click clones the doc — content, theme, image uploads, metadata — into a new URL you own.
category: writing
order: 14
---

# Duplicate a document

Got a doc you want to fork? The Duplicate action copies the live Y.js
state, the theme, the document context (description, audience,
language, template), and any image uploads to a new doc you own. The
new doc gets its own URL, its own activity log, and its own
collaborators (none, by default).

::flow{id="duplicate-a-document" hide-title}
::

## What just happened

`POST /api/docs/:id/duplicate` runs a transaction that:

1. Inserts a new row in `documents` with the duplicator as `user_id`.
2. Clones the Y.js snapshot from `yjs_documents` so the new doc opens
   identical to the source.
3. Copies the S3 image keys from `docs/{srcId}/` to `docs/{newId}/`
   and rewrites the markdown image URLs in the new Y.js content.
4. Carries over `description` / `audience` / `language` / `template_id`
   so AI context is preserved.

The endpoint honours the `Idempotency-Key` header so a network retry
mid-clone doesn't produce two duplicates.

## What's next

- [Set the duplicate's audience](/docs/writing/document-context) — sometimes a fork goes to a different reader.
- [Delete the old version](/docs/account/delete-document) — when the duplicate replaces the original.
