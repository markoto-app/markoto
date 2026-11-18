---
title: Work with long documents
description: Ask the AI about one part of a long handbook, or rename a term everywhere in one go, without it rereading the whole document.
category: ai
order: 4
updated: '2026-11-18'
---

# Work with long documents

A handbook, a thesis or a long specification is no problem for the AI. It
doesn't read the whole text for every request: it looks at the document's
outline first and then reads only the sections your request is about. So a
question about one rule in a 180-page handbook gets a quick answer, and a
change in chapter 7 doesn't need the other chapters at all.

## Ask about one section

Ask your question in the prompt bar as usual. You don't need to say where
the answer is; the AI finds the right section through the outline, reads
it and answers in the prompt bar, naming the section it took the answer
from. A question gets an answer, not an edit: your document stays as it is.

::flow{id="ask-about-one-section-of-a-long-document" hide-title}
::

Tips:

- **Headings help.** The AI finds its way through your headings, so a document with clear headings and numbered sections is easier for it to navigate.
- **Name the place if you know it.** "In section 4.2, ..." or "in the chapter about backups, ..." saves the AI a step.

## Rename something everywhere

A product got a new name, a term changed, a person's title is different
now: ask once, for example *Rename MyProduct to MySuperCoolProduct
everywhere*. The AI searches the whole document for every mention, checks
the list of matches, and then changes them all in one edit.

::flow{id="rename-a-name-everywhere-with-ai" hide-title}
::

What the rename leaves alone, so nothing breaks:

- **Code** (code blocks and inline code), math and HTML comments keep the old name, so commands and code samples still work.
- **Link addresses** keep the old name too, so links still lead where they did. The visible link text is renamed.
- **Headings** are renamed, and links to them keep working: markoto adds the heading's old link address as an `{#...}` marker at the end of the heading line, which the preview and the PDF don't show.

Matches are found regardless of upper and lower case, and the AI can also
catch the word's other forms (plural, compound words). If you want a
mention kept, say so in the prompt, for example *"except in the
changelog section"*.

Like any AI edit, the rename appears in the Activity tab and can be
undone ([restore an earlier version](/docs/import-export/restore)).

## When a change applies to many sections

Translating a long document, changing its tone throughout or updating
terminology in every chapter is more than a rename: each section has to
be rewritten. For that the AI starts a background job that works through
the sections one by one, with an estimate before it starts and a progress
panel while it runs. See [Translate or restyle a whole document](/docs/ai/document-jobs).

## What's next

- [Translate or restyle a whole document](/docs/ai/document-jobs): background jobs for document-wide rewrites.
- [Write with the AI prompt bar](/docs/ai/prompt-bar): the basics of prompting.
