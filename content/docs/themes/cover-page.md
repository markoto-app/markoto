---
title: Edit your cover page
description: Four cover-page layouts, an optional header image, size knobs — the front-page treatment is its own little design surface.
category: themes
order: 4
---

# Edit your cover page

The cover page is the first page of your PDF — the editorial
front-piece, before any body content. markoto ships four layouts
(editorial, centered, banded, minimal), an optional header image, and
size knobs for title / subtitle / author / date so the cover lands at
the right scale for the doc.

::flow{id="edit-your-cover-page" hide-title}
::

## What just happened

The Theme tab's Cover Page section is a sub-editor that writes into
the same theme JSONB column as the rest of the styling. Toggle the
cover off entirely (default for short docs) or pick a layout and
customise. The header image uploads through the same presigned-PUT
flow as inline images.

The cover renders in both the live preview and the exported PDF
through the same paged.js engine — what you see is what you ship.

## What's next

- [Tune the rest of the theme](/docs/themes/customize) — typography, colors, page geometry.
- [Save the look as a preset](/docs/themes/save-preset) — re-use the cover treatment on future docs.
