---
title: Save as Markdown
description: Download the doc as a `.md` file — clean, portable, edit anywhere.
category: import-export
order: 3
---

# Save as Markdown

Markdown is the lingua franca of writing tools — git, static-site
generators, every other editor reads it. markoto's Save as Markdown
hands you the raw `.md` file, ready to commit, paste into Obsidian, or
open in any other markdown editor.

::flow{id="save-as-markdown" hide-title}
::

## What just happened

Your browser saves the document exactly as it is right now as a `.md`
file named after its title. Nothing is sent anywhere first.

At the top of the file, between two `---` lines, markoto writes a short
block with the document's settings: title, description, audience,
language, the template it started from, and the whole theme, including
your custom CSS. Most Markdown tools ignore or hide this block (it is the
usual frontmatter format), and it is what lets markoto restore the look
when you import the file again.

Images stay links to markoto in the saved file rather than being
embedded, so they show up outside markoto only while the document is
reachable at its link.

## What's next

- [Export as PDF](/docs/import-export/polished-pdf) — same content, fully self-contained.
- [Import a document](/docs/import-export/import-existing): File › Import takes the `.md` file back. A file saved from markoto brings its theme and document settings with it; you can choose to keep only the text.
