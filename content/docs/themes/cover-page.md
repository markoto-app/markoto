---
title: Edit your cover page
description: Four cover-page layouts, an optional header image and size knobs. The front-page treatment is its own little design surface.
category: themes
order: 4
updated: '2026-11-08'
---

# Edit your cover page

The cover page is the first page of your PDF, the editorial
front-piece, before any body content. markoto ships four cover layouts
(editorial, centered, banded, minimal), an optional header image, and
size knobs for title / subtitle / author / date so the cover lands at
the right scale for the doc. A fifth layout, the title block, puts the
title at the top of page 1 instead, the way a paper starts.

::flow{id="edit-your-cover-page" hide-title}
::

## What just happened

The cover page is part of the document's theme, edited in the Cover
Page section of the Theme tab. Switch it off entirely (the default for
short documents) or pick a layout and adjust it. A header image uploads
like any other image.

The live preview and the exported PDF use the same layout engine, so
the cover you see is the cover you get.

## A title block for papers

Papers usually have no cover page: the title, the authors and the
abstract sit at the top of page 1 and the text starts right below. Pick
**Title block on page 1 (paper)** as the layout. The arXiv preprint
and IEEE conference paper presets use it.

- **Authors and affiliations.** Turn on *Show authors* and add each
  author. With the title block, every author gets a second field for the
  affiliation: department, institution, address or e-mail, one per line.
  Authors are set side by side.
- **Abstract.** Start your document with a section headed *Abstract*:

  ```markdown
  ## Abstract

  We measure how edge caches behave under network partitions …

  # Introduction
  ```

  That section moves into the title block, under the authors and the
  date, and leaves the table of contents. Everything up to the next
  heading belongs to it, so a *Keywords* line can go there too. The
  heading may also read *Zusammenfassung*, *Résumé*, *Resumen*, *概要* or
  *摘要*. In any other Markdown app the section shows as a normal one, so
  your file stays portable.
- **Rules and small capitals.** *Rules above and below the title* draws
  heavy lines around the title, as on an arXiv preprint; *Title in small
  capitals* sets title and subtitle in small caps (this one works with
  every layout).
- **Title weight.** The title is as bold as your headings unless you
  pick its own weight under *Title weight*, for example a regular-weight
  title over bold sections, as on an arXiv preprint. This works with every
  layout.

Page 1 shows no page header with the title block; the footer stays.

## What's next

- [Tune the rest of the theme](/docs/themes/customize): typography, colors, page geometry.
- [Save the look as a preset](/docs/themes/save-preset): re-use the cover treatment on future docs.
