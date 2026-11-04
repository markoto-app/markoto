---
title: Bring an existing document into markoto
description: Drop in a Word, PDF, or HTML file and markoto converts it to clean markdown ready to keep editing.
category: import-export
order: 2
featured: true
---

# Bring an existing document into markoto

If you have a draft already — a Word doc, a PDF, an HTML article — you
don't need to retype it. markoto converts the file to markdown on the
way in. Headings, lists, tables, bold/italic, code blocks all survive
the round-trip.

This walkthrough imports an HTML file into a fresh doc. About thirty
seconds. Desktop only — the File menu (which holds Import) is hidden
on mobile.

::flow{id="import-existing-document" hide-title}
::

## What just happened

You opened the import dialog from File → Import, picked a file, and
clicked Import. markoto converted it to Markdown on its servers and put the result in
the editor. Because the doc already had the Demo content
seeded, markoto offered to either replace or append; you chose
replace.

The accepted formats: `.docx`, `.pdf`, `.pptx`, `.xlsx`, `.html`,
`.htm`, `.epub`. Up to 50 MB. The conversion preserves structure;
custom fonts and page chrome are dropped (you're going to re-style
with a markoto theme anyway).

## Markdown files

A `.md` file (up to 10 MB) needs no conversion: its text goes into the
editor as it is.

If the file was [saved from markoto](/docs/import-export/save-markdown),
it starts with a block of settings between two `---` lines. markoto
reads that block instead of pasting it into your text, and offers to
apply the title, description, audience, language and theme (with its
custom CSS) to the document. Uncheck "Also apply the theme and document
settings" to keep only the text. Settings that aren't valid are left out,
and custom CSS rules that use another document's images are removed.

A block written by another tool (Jekyll, Hugo, Obsidian and similar) is
not markoto's, so it stays in your text, unchanged.

## What's next

- [Pick a theme](/docs/themes/pick-a-theme) — make the imported doc look the part.
- [Add tables, math, and diagrams](/docs/writing/rich-content) — go beyond what your source had.
