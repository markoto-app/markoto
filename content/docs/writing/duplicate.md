---
title: Duplicate a document
description: One click clones the doc — content, theme, image uploads, metadata — into a new URL you own.
category: writing
order: 14
updated: '2026-11-02'
---

# Duplicate a document

Got a doc you want to fork? The Duplicate action copies the text, the
theme, the document context (description, audience, language, template)
and any image uploads to a new doc you own. The
new doc gets its own URL, its own activity log, and its own
collaborators (none, by default). Comments are not copied: they stay on the original.

::flow{id="duplicate-a-document" hide-title}
::

## What just happened

markoto created a new document that you own, copied the current content
so it opens identical to the source, copied the uploaded images into the new
document (and pointed its image links at the copies), and carried over the
description, audience, language and template so the AI keeps its context.
The copy has its own address, its own activity log and no collaborators; a network retry in the middle won't produce two duplicates.

## What's next

- [Set the duplicate's audience](/docs/writing/document-context) — sometimes a fork goes to a different reader.
- [Delete the old version](/docs/account/delete-document) — when the duplicate replaces the original.
