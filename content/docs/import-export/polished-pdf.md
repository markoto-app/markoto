---
title: Polish your doc and download it as a PDF
description: Pick a theme, watch the live preview repaginate, then export a server-rendered PDF in one click.
category: import-export
order: 1
featured: true
---

# Polish your doc and download it as a PDF

The live preview in markoto is the same paged.js engine that drives the
PDF export — the file you download is byte-for-byte what you see in the
right pane. So polishing a doc is two steps: pick a theme, then hit
File → Save as PDF.

This walkthrough switches to the academic-paper preset and exports the
result. About one minute. Desktop only — the menubar (which holds Save
as PDF) is hidden on mobile.

::flow{id="polished-pdf" hide-title}
::

## What just happened

You opened the Theme panel from the right sidebar, picked a preset, and
watched paged.js repaginate the doc with new fonts, page proportions,
and brand color. Then File → Save as PDF triggered the renderer
sidecar — a headless Chromium running paged.js server-side — and the
result was streamed back as a download.

The PDF is rendered on the server by a headless browser that uses exactly
the same theme as your preview, so the page breaks you saw are the page
breaks you get. A new render takes 5-15 seconds; asking again for the same
document and theme, without edits, is near-instant. PDF downloads are limited
to 10 per minute per address. If the PDF renderer is unavailable, the
download fails with an error rather than falling back to a different
layout.

## What's next

- [Lock the doc with a password](/docs/sharing/password-protect) — gate the PDF link behind a passphrase.
- [Pick a different theme](/docs/themes/pick-a-theme) — six presets, all preview-perfect.
