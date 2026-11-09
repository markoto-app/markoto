---
title: Markdown report template with PDF export
description: A Markdown report template for quarterly, annual and project reports - cover, contents, key figures, charts and footnotes, exported as a paged PDF.
keywords:
  - markdown report template pdf
  - markdown report template
  - quarterly report template
  - project report markdown
  - markdown to pdf report
updated: '2026-11-06'
navGroup: templates
navLabel: Report template
navOrder: 10
---

# Markdown report template, printed as pages

A report is read on paper or as a PDF, so the layout matters as much as the text: a cover, a table of contents with page numbers, tables that line up, charts, and notes at the foot of the page. In markoto you write all of it in Markdown and the preview shows the pages as you go.

These pages are from a 12-page quarterly report written in markoto for a made-up software company. The text is Markdown; the chart is a Mermaid diagram typed into the source; the theme adds the running header and the page numbers.

::page-shots{caption="Three pages of the example quarterly report: the executive summary with footnotes, the key figures and revenue tables, and a bar chart drawn from numbers in the source."}
---
pages:
  - src: /tour/light/share/sharePdf-0-720.webp
    small: /tour/light/share/sharePdf-0-400.webp
    alt: Report page with the executive summary, a list of highlights and two footnotes at the foot of the page.
  - src: /tour/light/share/sharePdf-1-720.webp
    small: /tour/light/share/sharePdf-1-400.webp
    alt: Report page with a key figures table, a note box and a revenue table by segment.
  - src: /tour/light/share/sharePdf-2-720.webp
    small: /tour/light/share/sharePdf-2-400.webp
    alt: Report page with a bar and line chart of quarterly revenue and a table of revenue by region.
---
::

::cta{title="Start your report from this template." label="Use this template" template="report" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the report template selected. It comes with the Corporate report theme, which has a cover page. The template is the outline of the report above, with a short brief in each section.
::

## What's in it

- **Cover page and table of contents.** The theme draws the cover from the document title, a subtitle, the date and the authors. `[[toc]]` lists the sections with page numbers.
- **Executive summary.** Half a page for readers who stop there: what happened, the three numbers that matter, what you want them to decide.
- **Highlights.** Four to six bullets, each a bold claim with the number behind it.
- **Key figures.** A table of this period, the previous period, the same period a year ago and the change.
- **Results.** One subsection per area, each opening with its number.
- **Risks and outlook,** then an **appendix** for definitions and full tables after a page break.

The briefs under the headings are Markdown comments: visible in the editor and to the AI assistant, never on the page or in the PDF.

## What the report above uses

- **Tables with right-aligned figures**, including one wide table with smaller type.
- **Charts**: Mermaid `xychart-beta` for bars and lines, plus `pie` and `flowchart`, drawn in the theme's colours.
- **Footnotes** that print at the foot of their page.
- **Alerts** (`> [!NOTE]`, `> [!WARNING]`) for remarks that must stand out.
- **A custom theme**: IBM Plex Sans for the text, Source Serif 4 for the headings, a running header, "page / pages" in the footer and a few lines of custom CSS for the figures.

The template opens with the built-in **Corporate report** theme instead. Change fonts, colours, the header and the footer in the document theme, and save the result as your own preset to reuse it for the next report.

## Who it's for

Finance and operations teams writing quarterly or board reports, project leads writing status reports, consultants and analysts delivering a report as a PDF. Several people can write different sections at the same time, comment on figures and restore an earlier version.

## Questions

::faq{json-ld}
---
items:
  - q: Does the PDF look like the preview?
    a: Yes. The preview and the PDF use the same page layout and theme, so the pages break in the same places, including the cover and the table of contents.
  - q: Can I add charts?
    a: Yes. Type a Mermaid diagram into the source, for example an xychart-beta block with your numbers, and it is drawn on the page in the theme's colours.
  - q: Can I put our logo on the cover and in the header?
    a: Yes, with an account, because logos are uploads. The theme has a logo for the cover and an image slot in the header and footer.
  - q: Can I reuse the layout for every quarter?
    a: Yes. Save the theme as your own preset, or duplicate last quarter's report and update the numbers. Both need an account.
---
::

::cta{title="Write the report once, print it every quarter." label="Use this template" template="report"}
Free on markoto.app, no sign-up needed.
::
