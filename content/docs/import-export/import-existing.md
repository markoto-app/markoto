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
clicked Import. markoto converted it to Markdown on its servers (with
Microsoft's open-source markitdown library) and put the result in the
editor. Because the doc already had the welcome content
seeded, markoto offered to either replace or append; you chose
replace.

The accepted formats: `.docx`, `.pdf`, `.pptx`, `.xlsx`, `.html`,
`.htm`, `.epub`. Up to 50 MB. The conversion preserves structure;
custom fonts and page chrome are dropped (you're going to re-style
with a markoto theme anyway).

## What's next

- [Pick a theme](/docs/themes/pick-a-theme) — make the imported doc look the part.
- [Add tables, math, and diagrams](/docs/writing/rich-content) — go beyond what your source had.
