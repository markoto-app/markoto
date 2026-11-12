---
title: Pick a theme that fits your document
description: Switch between built-in presets, see the live preview update, and turn page 1 into a dedicated cover sheet.
category: themes
order: 1
featured: true
updated: '2026-11-09'
---

# Pick a theme that fits your document

Every markoto document carries its own theme: fonts, colors, page
margins, table styling, even cover-page layout. The theme drives
both the live preview AND the PDF export, so what you see in the
right pane is what you ship.

This walkthrough covers the basics: picking a preset, watching the
live preview update, and turning on a cover page. About two minutes.

::flow{id="pick-a-theme" hide-title}
::

## What just happened

You picked a built-in preset, watched the entire document re-skin
in place, then turned on a cover sheet that suppresses the running
header and footer on page 1.

A document starts in the design of the template you picked in the
new-document dialog ([Start from a template](/docs/getting-started/templates)):
the runbook template in the On-call runbook preset, the report in
Corporate report, Blank in your default. Switching the preset here
changes only the look; the text stays as it is.

The built-in presets cover most use cases:

- **markoto**: the default. Fraunces editorial headings on Inter
  body, plain white paper, vermillion accents, asterism scene breaks.
  The "calm field guide" voice.
- **Modern**: clean Inter sans, blue accent, justified body. The
  neutral starting point.
- **arXiv preprint**: the look of an arXiv LaTeX preprint: US Letter,
  Times at 10 pt, a title block between heavy rules in small capitals,
  numbered bold sections and an "A Preprint" running head over a thin
  rule. Start the document with an *Abstract* section and mark the
  references `# References {.unnumbered}`.
- **IEEE conference paper**: the IEEEtran conference look: US Letter,
  two columns of Times 10 pt, centred small-caps sections with Roman
  numerals, a 24 pt title over side-by-side author blocks and the
  run-in abstract in the first column.
- **Thesis**: long-form academic writing in the LaTeX report
  tradition: A4, Latin Modern 11 pt with paragraph indents, every
  chapter on a new page under a large number, sections numbered
  1.1 / 1.1.1 and a classic title page.
- **Technical documentation**: Source Serif reading text with Source
  Sans headings, section numbers hanging in the margin, light framed
  code blocks with file titles, the current chapter in the running
  head.
- **Design doc / RFC**: for engineering design documents, RFCs and
  decision records: a calm sans with a review margin beside the prose,
  a metadata table up front, numbered decisions and wide comparison
  tables.
- **Corporate report**: a cover page with a petrol band, Source Serif
  headings over Inter, finance-style tables with ruled totals, pull
  quotes and a quiet footer rule.
- **Memo / letter**: a one- or two-page memo or business letter:
  start with *To / From / Date / Subject* lines (a bold label each,
  ending the lines with a backslash) and a `---` rule; the labels and
  your `##` headings sit in a margin column. A paragraph that opens
  with your bold name gets room to sign above it; an italic last line
  becomes a small cc line.
- **Client proposal**: a proposal you send to a client: a cover
  panel, numbered sections, a timeline, pricing tables with subtotal,
  VAT and total, and a signature block at the end.
- **One-pager**: a product or project fact sheet that fits on one
  page: a title block under an orange bar, the pitch as a bold first
  paragraph, section labels in a left column, a compact key-facts
  table and a filled *Important* callout. Start with a bold paragraph
  to get the large lead.
- **Academic essay (APA)**: the APA 7 student paper: Times 12 pt
  double-spaced, a title page with your name, course, instructor and
  date, the page number top right, centred bold headings and the
  references on a new page with hanging indents.
- **Fiction book**: a typeset novel interior: A5 pages, EB Garamond
  with paragraph indents, every chapter on a new page under its
  number, scene breaks (`---` or `* * *`) as three asterisks, the book
  title as the running head, a title page and an epigraph page for a
  quotation placed before the first chapter.
- **Newsletter**: a newsletter to print or send as a PDF: a bold
  masthead with the issue line, headlines and captioned photos across
  the page over two columns of text, pull quotes, a terracotta accent.
- **Newsletter**: two-column Karla over PT Serif, green accent,
  weekly-digest density.
- **Resume**: one dense page: Inter at 10 pt, small headings with
  a rule, no running header, page number or cover.

## Tweaking a preset

Presets are starting points, not constraints. Open the right panel's
sections (Body, Headings, Color, Cover page) and any field you
change applies on top of the picked preset. Save a doc with a
custom feel and the next document still starts at markoto.

## What's next

- [Configure your cover page](/docs/themes/cover-page): multi-author
  list, subtitle, brand logo placement.
- [Tune typography and colors](/docs/themes/customize): drop
  caps, first-line indent, paragraph spacing, font swaps.
- [Save your tuning as a preset](/docs/themes/save-preset): re-use on
  the next doc.
- [Export your themed document](/docs/import-export/polished-pdf): the
  preview-CSS pipeline produces the same PDF.
