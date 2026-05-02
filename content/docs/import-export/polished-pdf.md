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

The PDF render is **cached per snapshot**. Every PDF download for a
given doc + theme combo after the first hits S3 in under a second; the
cold render takes 5–15 seconds. So the *second* PDF you ask for is
near-instant, even if the first one took a beat.

## What's next

- [Lock the doc with a password](/docs/sharing/password-protect) — gate the PDF link behind a passphrase.
- [Pick a different theme](/docs/themes/pick-a-theme) — six presets, all preview-perfect.
