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

Save as Markdown reads your current Y.js doc state, writes it to a
Blob with `text/markdown` mime, and triggers a browser download named
after the doc title. No server round-trip — the export is computed
client-side from the in-memory Y.Doc.

Inline images are referenced by URL (`/api/files/{docId}/{fileId}`)
in the saved markdown, not inlined as base64. Open the file outside
markoto and the images won't resolve unless the host is reachable —
that's a current limitation tracked in the roadmap.

## What's next

- [Export as PDF](/docs/import-export/polished-pdf) — same content, fully self-contained.
- [Bring the doc back in later](/docs/import-export/import-existing) — import the `.md` file into a fresh doc.
