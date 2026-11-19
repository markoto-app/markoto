---
title: Polish your doc and download it as a PDF
description: What you see in the preview is what lands in the PDF. Export it from the File menu in one click.
category: import-export
order: 3
updated: '2026-11-19'
---

# Polish your doc and download it as a PDF

The preview on the right is the PDF: same theme, same fonts, same cover
page, same page breaks. So polishing a document comes down to two steps:
make it look right in the preview, then choose **File › Export › PDF**.

This walkthrough exports a short research summary and opens the result. It
takes about a minute. On a phone, the same item is in the menu at the top
right.

::flow{id="polished-pdf" hide-title}
::

## What just happened

markoto turned the document into a PDF on its servers, using exactly the
theme you see in the preview, and your browser downloaded it. A fresh export
takes a few seconds; exporting the same document again without changes is
almost instant. You can export up to 10 PDFs a minute.

If the PDF can't be created (for example during maintenance), markoto says
so instead of handing you a file that looks different from your preview.

Prefer your browser's print dialog? **File › Print** (or `Cmd/Ctrl + P`)
prints the same paged view.

## How pages break

You don't place page breaks by hand (though `<!-- pagebreak -->` forces one).
markoto keeps a heading with the text it introduces, also at the end of a
column in two-column themes, and keeps a definition term with its
description. Short code blocks and tables stay in one piece unless that would
leave a large empty space at the bottom of a page: then they split, with at
least three lines or rows on each side. A table that continues on the next
page repeats its header row. In two-column themes a footnote stays on the
page of its reference.

## Accessible PDFs

The exported PDF is a tagged PDF, so screen readers and other assistive
technology can follow it: headings, lists, tables, links and images keep
their meaning, and the image descriptions you write
(`![A chart of monthly sales](...)`) travel with the images. The PDF also
carries the document's title (shown in the PDF viewer's title bar), its
language (from the Document tab) and bookmarks built from your headings.

While you write, the status bar at the bottom of the editor counts what
would make the document harder to use with assistive technology: an image
without a description, a link without text (`[](https://...)`), or a
heading that skips a level (a level 3 heading straight after a level 1).
Click the count to see the list; click an entry to jump to that line.

## What's next

- [Pick a theme](/docs/themes/pick-a-theme): built-in presets, each one exactly what the PDF will look like.
- [Edit your cover page](/docs/themes/cover-page): title, subtitle, logo and layout.
- [Lock the doc with a password](/docs/sharing/password-protect): gate the link (and the PDF) behind a passphrase.
