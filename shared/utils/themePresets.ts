import type { DocTheme } from '../types/theme'

/**
 * Built-in theme templates. Each preset is a complete DocTheme that
 * fully replaces the user's current settings when selected. Names and
 * descriptions live in i18n under `theme.presets.<id>.{name,description}`.
 *
 * Presets exercise the full theme surface — body + headings + tables +
 * code variants — so they double as a tour of what the theme system can
 * do. Adding a preset is: (a) append here with a unique `id`, (b) add
 * matching i18n keys.
 */

/**
 * Who a preset is for — the tabs of the new-document design picker. A
 * `general` preset (the brand look, an all-rounder) shows under "All" only.
 */
export const THEME_PRESET_CATEGORIES = ['engineering', 'academic', 'business', 'writing'] as const
export type ThemePresetCategory = typeof THEME_PRESET_CATEGORIES[number] | 'general'

export interface ThemePreset {
  id: string // matches i18n key under theme.presets.<id>
  category: ThemePresetCategory
  theme: DocTheme
}

/**
 * ARXIV_TEMPLATE_CSS — the part of the arXiv preprint look no theme
 * field expresses (kourgeorge/arxiv-style, MIT; values from arxiv.sty).
 * Everything else (Letter page, Termes 10/11, numbered bold sections at
 * 12/10/10pt via `headings.levels`, title block with rules + small caps
 * at regular weight, running head with its rule) is plain theme values.
 * A preset's template CSS is ordinary `customCss`: it goes through the
 * same sanitizer as the author's own CSS at write and render time
 * (pinned by tests/unit/themePresetCss.test.ts) and the author can edit it.
 */
const ARXIV_TEMPLATE_CSS = `/* arXiv preprint template (kourgeorge/arxiv-style, MIT). Values from arxiv.sty. */
/* \\rhead{\\scshape\\footnotesize A Preprint}; fancyhdr sets the head in full black. */
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-right { font-variant-caps: small-caps; }
.pagedjs_pages .pagedjs_page .pagedjs_margin { opacity: 1; }
/* \\@maketitle: \\vskip 0.1in, 2pt bars 0.25in / 0.29in around the title, author/date \\vskips. */
.paged-doc .markoto-title-block { padding-top: 7pt; }
.paged-doc .markoto-title-block .markoto-cover-title { padding: 16pt 0 11pt; margin: 0; }
.paged-doc .markoto-title-block .markoto-cover-subtitle { margin-top: 9pt; }
.paged-doc .markoto-title-block .markoto-cover-authors { margin-top: 20pt; }
.paged-doc .markoto-title-block .markoto-cover-affiliation { line-height: 1.05; }
.paged-doc .markoto-title-block .markoto-cover-date { margin-top: 28pt; }
/* abstract: \\centerline{\\large\\bfseries\\scshape Abstract} over a normal-size quote. */
.paged-doc .markoto-abstract { margin-top: 14pt; font-size: 1em; }
.paged-doc .markoto-abstract-title { font-size: 12pt; letter-spacing: 0; margin-bottom: 9pt; }
/* \\@startsection: the number, then a quad. */
.paged-doc h1::before, .paged-doc h2::before, .paged-doc h3::before { margin-right: 1em; }
/* \\texttt: typewriter, no box. */
.paged-doc :not(pre) > code { background: none; padding: 0; border: 0; font-size: 1em; }
/* figure: \\abovecaptionskip 7pt, "Figure N:" caption in roman (the label is the theme's blocks.figureLabel). */
.paged-doc figure { margin: 12pt 0; }
.paged-doc figure img { display: block; margin: 0 auto; }
.paged-doc figcaption { font: inherit; color: inherit; margin-top: 7pt; }
/* table: "Table N:" caption above in roman (tables.captionLabel), \\abovecaptionskip 7pt. */
.paged-doc table > caption { font: inherit; color: inherit; padding-bottom: 7pt; }
/* booktabs: centred at natural width, \\toprule + \\bottomrule heavier than \\midrule. */
.paged-doc table { width: auto; margin: 10pt auto; }
.paged-doc table thead th { border-top: 0.08em solid; border-bottom: 0.05em solid; font-weight: 400; }
.paged-doc table tbody tr:last-child td { border-bottom: 0.08em solid; }
.paged-doc th, .paged-doc td { padding: 1pt 6pt; }
/* lists: \\leftmargini 3pc, \\topsep 4pt, \\itemsep + \\parsep 2pt each. */
.paged-doc ul, .paged-doc ol { padding-left: 36pt; margin: 4pt 0; }
.paged-doc li { margin: 4pt 0; }
/* natbib bibliography: hanging indent (blocks.referenceStyle) of 1.2em, 5pt between entries. */
.paged-doc p.markoto-references { --doc-reference-indent: 1.2em; margin: 0 0 5pt; }
/* hyperref links print as plain text. */
.paged-doc a { text-decoration: none; }
`

/**
 * IEEE_CONFERENCE_TEMPLATE_CSS — the part of the IEEE conference look no
 * theme field expresses (IEEEtran.cls 1.8b, LPPL; bare_conf.tex; values
 * from IEEEtran.cls in 10pt conference mode). Letter page, Termes 10/12,
 * two 21pc columns 1pc apart, small-caps / italic sections at body size
 * and the regular-weight 24pt title are theme values.
 */
const IEEE_CONFERENCE_TEMPLATE_CSS = `/* IEEE conference paper (IEEEtran.cls 1.8b, LPPL). Values from IEEEtran.cls, 10pt conference mode. */
/* \\@maketitle: \\Huge 24/28pt title, 0.5\\baselineskip + 0.2em above, 1em - 0.25em to the author blocks. */
.paged-doc .markoto-title-block { margin: 0 0 6pt; }
.paged-doc .markoto-title-block .markoto-cover-title { line-height: 28pt; margin: -4pt 0 18pt; }
/* \\and = \\hfill: author blocks share the width; \\IEEEauthorblockN \\sublargesize (11pt) regular, \\IEEEauthorblockA \\normalsize, 2.6ex / 2.75ex lines. */
.paged-doc .markoto-title-block .markoto-cover-authors { justify-content: space-evenly; gap: 0; margin: 0 0 40pt; }
.paged-doc .markoto-title-block .markoto-cover-author { font-weight: 400; font-size: 1.1em; line-height: 11.5pt; white-space: pre-line; }
.paged-doc .markoto-title-block .markoto-cover-affiliation { line-height: 12.5pt; }
/* Two-column \\abstract + IEEEkeywords open the first column: only title and authors span the page. */
/* Only with an abstract: it opens column 1, so the title block itself must not span (title + authors span instead). Without an abstract the block keeps the engine's span — otherwise a page-1 footnote leaves page 1 blank (paged.js). */
.paged-doc .markoto-cover:has(.markoto-abstract) { column-span: none; }
.paged-doc .markoto-title-block .markoto-cover-title, .paged-doc .markoto-title-block .markoto-cover-authors { column-span: all; }
/* \\abstract: \\small (9/10pt) bold, run-in \\textit{Abstract}---, \\parindent 1em. */
.paged-doc .markoto-abstract { max-width: none; margin: 0; font-size: 9pt; line-height: 10pt; font-weight: 700; text-align: justify; }
.paged-doc .markoto-abstract p { margin: 0; text-indent: 1em; }
.paged-doc .markoto-abstract-title { display: inline; font: inherit; font-style: italic; font-variant-caps: normal; letter-spacing: 0; margin: 0; padding-left: 1em; }
.paged-doc .markoto-abstract-title::after { content: "\\2014"; font-style: normal; }
.paged-doc .markoto-abstract-title + p { display: inline; text-indent: 0; }
/* Every paragraph indented \\parindent 1em, also the first after a heading; text after a list continues the paragraph. */
.paged-doc > p, .paged-doc > p + p { text-indent: 1em; }
.paged-doc > ul + p, .paged-doc > ol + p { text-indent: 0; }
/* \\section / \\subsection: 1.5ex above, 0.7ex below (numbers "I." / "A." and the centred section come from the theme). */
.paged-doc h1, .paged-doc h2 { margin: 6.75pt 0 3.15pt; break-after: avoid; }
/* \\subsubsection: run-in at \\parindent, "1)" and ":" after the heading (inline with its paragraph, so the two never part at a column break). */
.paged-doc h3 { display: inline; margin: 0 0.35em 0 1em; }
.paged-doc h3::after { content: ":"; }
.paged-doc h3 + p { display: inline; text-indent: 0; }
/* itemize / enumerate: \\leftmargini 2em, bullet and "1)" labels \\labelsep 0.5em before the text, \\topsep 2pt, no \\itemsep. */
.paged-doc ul, .paged-doc ol { padding-left: 2em; margin: 2pt 0; }
.paged-doc li { margin: 0; }
.paged-doc ul > li:not(.task-list-item) { list-style: none; }
.paged-doc ul > li:not(.task-list-item)::before { content: "\\2022"; display: inline-block; box-sizing: border-box; width: 2em; margin-left: -2em; padding-right: 0.5em; text-align: right; }
.paged-doc ol > li::marker { content: counter(list-item) ")\\a0\\a0"; }
/* \\footnoterule is empty; \\@makefntext: superscript mark, first line indented 1em. */
.pagedjs_pages .pagedjs_page .pagedjs_footnote_content { background: none; }
.pagedjs_pages .pagedjs_page .pagedjs_footnote_area .footnote { text-indent: 1em; line-height: 9pt; }
.pagedjs_pages .pagedjs_page .pagedjs_footnote_area [data-footnote-marker]::marker { content: none; }
.pagedjs_pages .pagedjs_page .pagedjs_footnote_area [data-footnote-marker]::before { content: counter(footnote-marker); vertical-align: super; font-size: 0.75em; line-height: 0; }
/* table: \\footnotesize body, caption above (Table: …): "TABLE I" (\\Roman) on its own line, then the caption in small caps, centred. */
.paged-doc table > caption { font: inherit; font-size: 8pt; line-height: 9pt; font-style: normal; color: inherit; font-variant-caps: small-caps; padding-bottom: 9.5pt; }
.paged-doc table > caption::before { content: "TABLE " counter(mk-table, upper-roman); display: block; font-variant-caps: normal; }
.paged-doc table { width: auto; margin: 12pt auto; font-size: 8pt; line-height: 9pt; border-top: 0.4pt solid; border-bottom: 0.4pt solid; }
.paged-doc th, .paged-doc td { padding: 0 6pt; font-weight: 400; }
/* \\hline: 0.4pt above the table (on the table rule), below the header and at the end. */
.paged-doc thead { border-bottom: 0.4pt solid; }
/* figure: centred, "Fig. 1." + two spaces, \\footnotesize caption below, centred when it fits one line, else justified. */
.paged-doc figure { margin: 12pt 0; text-align: center; }
.paged-doc figure img { display: block; margin: 0 auto; }
.paged-doc figcaption { font: inherit; font-size: 8pt; line-height: 9pt; font-style: normal; color: inherit; margin-top: 9pt; text-align: justify; text-align-last: center; }
.paged-doc figcaption:not(:empty)::before { content: "Fig. " counter(mk-figure) ".\\a0\\a0"; }
/* thebibliography: \\footnotesize, "[1]" labels (blocks.referenceStyle: brackets) in a hanging list. */
.paged-doc ol.markoto-references { padding-left: 1.75em; font-size: 8pt; line-height: 9pt; }
/* \\texttt: typewriter, no box. hyperref is not loaded: links print as text. */
.paged-doc :not(pre) > code { background: none; padding: 0; border: 0; font-size: 1em; }
.paged-doc a { text-decoration: none; color: inherit; }
`

/**
 * TECH_DOCS_TEMPLATE_CSS — what the "Technical documentation" look needs
 * beyond theme fields: sans "furniture" (tables, admonition and code
 * titles, TOC chapters) around a serif reading text, accent heading
 * numbers, hairline-ruled tables, quieter admonitions and inline code.
 * Ordinary custom CSS (tests/unit/themePresetCss.test.ts).
 */
const TECH_DOCS_TEMPLATE_CSS = `/* Technical documentation template. */
/* Grid: prose in a column 30 mm in from the text edge (about 85 characters);
   section numbers hang in that gutter; code, tables, diagrams and the title
   block use the full width (about 90 columns of code before a line wraps). */
.paged-doc { --td-gutter: 30mm; padding-left: var(--td-gutter); }
.paged-doc > pre, .paged-doc > .code-block, .paged-doc > .mermaid, .paged-doc > hr, .paged-doc > .markoto-cover { margin-left: calc(-1 * var(--td-gutter)); }
.paged-doc > table { margin-left: calc(-1 * var(--td-gutter)); width: calc(100% + var(--td-gutter)); }
/* The contents list uses the full width too (its section numbers line up with the text edge). */
.paged-doc > .table-of-contents { margin-left: calc(-1 * var(--td-gutter)); }
.paged-doc h1:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before, .paged-doc h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before, .paged-doc h3:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before, .paged-doc h4:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { display: inline-block; width: var(--td-gutter); margin-left: calc(-1 * var(--td-gutter)); margin-right: 0; color: var(--doc-brand); }
/* Chapters (h1) open under a hairline across the full width. */
.paged-doc h1:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered) { margin-left: calc(-1 * var(--td-gutter)); padding: 6pt 0 0 var(--td-gutter); border-top: 0.5pt solid var(--doc-secondary); }
/* Inline code: a faint tint, tight padding so it doesn't push the punctuation away; plain in headings. */
.paged-doc :not(pre) > code { font-size: 0.86em; padding: 0.05em 0.2em; background: color-mix(in srgb, var(--doc-text) 6%, transparent); }
.paged-doc h1 code, .paged-doc h2 code, .paged-doc h3 code, .paged-doc h4 code { background: none; padding: 0; font-size: 0.92em; }
/* Code titles read as file tabs: sans, dark, semibold, inside the block's hairline frame. */
.paged-doc .code-title { font-family: var(--doc-heading-font); font-weight: 600; font-size: 8pt; color: var(--doc-heading-color); border: 0.75pt solid color-mix(in srgb, var(--doc-secondary) 70%, transparent); }
.paged-doc .code-title + pre { border-top: 0; }
/* A wrapped code line continues 4 columns in, so it can't be mistaken for a new line. */
.paged-doc pre .code-line { padding-left: 4ch; text-indent: -4ch; }
/* Tables are reference material: sans, a step smaller, tabular figures, hairline rows under a firm header rule. */
.paged-doc table { font-family: var(--doc-heading-font); font-size: 0.92em; line-height: 1.3; font-variant-numeric: tabular-nums; }
.paged-doc thead th { border-bottom: 0.75pt solid var(--doc-text); vertical-align: bottom; }
.paged-doc tbody tr { border-bottom: 0.4pt solid color-mix(in srgb, var(--doc-secondary) 55%, transparent); }
.paged-doc td code, .paged-doc th code { font-size: 0.9em; background: none; padding: 0; }
/* Identifiers in cells break only where they must (the engine's "anywhere" split "pg.Pool" into "pg.Poo / l"). */
.paged-doc td code { overflow-wrap: break-word; }
/* Reference cells hold type names and identifiers: no automatic hyphenation ("inte-ger"). */
.paged-doc th, .paged-doc td { hyphens: manual; }
/* Admonitions: a thin coloured rule and a faint wash; the title (sans, the kind in words) carries the meaning in greyscale. */
.paged-doc .markdown-alert { border-left-width: 2.5pt; border-radius: 0; padding: 0.5em 0.9em; }
.paged-doc .markdown-alert-title { font-family: var(--doc-heading-font); font-size: 0.85em; letter-spacing: 0.06em; margin-bottom: 0.25em; }
/* TOC: chapters in the heading sans, sections in the text face. */
.paged-doc .table-of-contents > ul > li > a { font-family: var(--doc-heading-font); font-weight: 600; }
.paged-doc .table-of-contents::before { font-size: 1.1em; font-weight: 600; }
/* Glossary terms in the heading sans. */
.paged-doc dt { font-family: var(--doc-heading-font); }
/* Links print as accent text without underline (mostly cross-references). */
.paged-doc a { text-decoration: none; }
`

/**
 * BUSINESS_REPORT_TEMPLATE_CSS — what the business-report look needs beyond
 * theme fields: the two-width grid, section-opener bars, finance-style
 * tables (tabular figures, hairlines, rules on bold total rows), pull
 * quotes, square callouts and the cover composition. Same rules as the
 * arXiv template CSS (sanitised, editable by the author).
 */
const BUSINESS_REPORT_TEMPLATE_CSS = `/* Business report template. A two-width grid: prose in a ~75-character column, tables, charts and callouts across the full text width. */
.paged-doc > p, .paged-doc > ul, .paged-doc > ol, .paged-doc > dl, .paged-doc > blockquote { max-width: 128mm; }
/* Section openers: a short accent bar over every h1 gives rhythm without a page break. */
.paged-doc h1:not(.markoto-cover-title) { padding-top: 9pt; background: linear-gradient(var(--doc-brand), var(--doc-brand)) top left / 12mm 2pt no-repeat; }
/* The first paragraph of a section is its lead: a step larger, in heading ink. */
.paged-doc > h1 + p { font-size: 1.1em; line-height: 1.45; color: var(--doc-heading-color); }
/* A section that opens with a subsection needs no full gap between the two. */
.paged-doc h1 + h2 { margin-top: 0; }
/* Contents: a page of their own in the prose column, the title set like a section opener, one group per section between hairlines. */
.paged-doc .table-of-contents { break-after: page; max-width: 128mm; }
.paged-doc .table-of-contents::before { font-size: 2em; font-weight: 600; padding-top: 9pt; margin-bottom: 1em; background: linear-gradient(var(--doc-brand), var(--doc-brand)) top left / 12mm 2pt no-repeat; }
.paged-doc .table-of-contents > ul > li { padding: 0.5em 0; border-bottom: 0.5pt solid color-mix(in srgb, var(--doc-secondary) 55%, transparent); }
.paged-doc .table-of-contents > ul > li + li { margin-top: 0; }
.paged-doc .table-of-contents > ul > li > a { font-weight: 600; color: var(--doc-heading-color); }
.paged-doc .table-of-contents > ul > li > a::after { color: var(--doc-heading-color); }
.paged-doc .table-of-contents ul ul a { color: color-mix(in srgb, var(--doc-text) 75%, var(--doc-bg)); }
/* Finance tables: tabular lining figures, compact rows, hairlines between rows, a firm rule under the header and at the foot, no fills. */
.paged-doc table { font-variant-numeric: lining-nums; line-height: 1.35; margin: 1.1em 0 1.3em; }
/* Figures line up in right-aligned (numeric) columns; text columns keep proportional punctuation (Inter's tabular hyphen is wide). */
.paged-doc td[style*="right"], .paged-doc th[style*="right"] { font-variant-numeric: lining-nums tabular-nums; }
.paged-doc th { font-size: 0.88em; font-weight: 600; color: var(--doc-heading-color); vertical-align: bottom; }
.paged-doc tr { border-bottom: 0.5pt solid color-mix(in srgb, var(--doc-secondary) 55%, transparent); }
.paged-doc thead tr { border-bottom: 1pt solid var(--doc-heading-color); }
.paged-doc tbody tr:last-child { border-bottom: 1pt solid var(--doc-heading-color); }
/* Totals and subtotals: a row whose label is bold, after a plain row, gets a rule above it (a key/value table with bold labels throughout keeps hairlines). */
.paged-doc tbody tr:not(:has(> td:first-child > strong)) + tr:has(> td:first-child > strong) > td { border-top: 1pt solid var(--doc-heading-color); }
/* A header row with no labels (key/value tables) is not drawn. */
.paged-doc thead tr:not(:has(> th:not(:empty))) { display: none; }
/* Pull quotes: serif italic in heading ink; a last paragraph after the quote is its attribution. */
.paged-doc blockquote { font-family: var(--doc-heading-font); font-size: 1.18em; line-height: 1.4; color: var(--doc-heading-color); border-left: 2pt solid var(--doc-brand); padding-left: 1.1em; margin: 1.4em 0; }
.paged-doc blockquote > p:last-child:not(:first-child) { font-family: var(--doc-body-font); font-style: normal; font-size: 0.72em; color: var(--doc-secondary); margin-top: 0.6em; }
/* Callouts: square, a thin rule, a lighter tint, a step smaller than the text. */
.paged-doc .markdown-alert { border-left-width: 2pt; border-radius: 0; padding: 0.8em 1.1em; font-size: 0.92em; }
/* Cover: aligned with the text block; title in the upper half, organisation and date at the foot over a hairline. */
.paged-doc .markoto-cover { padding: 30mm 22mm 24mm; }
.paged-doc .markoto-cover--no-logo { background: linear-gradient(var(--doc-brand), var(--doc-brand)) top left / 5mm 100% no-repeat; }
.paged-doc .markoto-cover-title { line-height: 1.1; letter-spacing: -0.015em; }
.paged-doc .markoto-cover-subtitle { font-style: normal; color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg)); margin-top: 0.5em; max-width: 140mm; line-height: 1.4; }
.paged-doc .markoto-cover-meta { grid-row: 6; align-self: end; min-width: 100%; }
.paged-doc .markoto-cover-author { font-weight: 600; }
`

/**
 * MEMO_TEMPLATE_CSS — what the memo / business-letter look needs beyond
 * theme fields: the label-column grid (To / From / Date / Subject labels and
 * side heads hang in a 32 mm column, the text beside it), the letterhead
 * mark, rules across both columns, calm hairline tables, room to sign and a
 * quiet cc line, page numbers from page 2 on. Same rules as the other
 * template CSS (sanitised, editable by the author).
 */
const MEMO_TEMPLATE_CSS = `/* Memo / business letter. A4 on a two-column grid (Swiss business-letter style, DIN 5008 margins): a 32 mm label column at the page margin, the text in a ~75-character column beside it. */
/* paged.js rewrites every selector with a "+" into a low-specificity attribute rule, so this CSS uses ":has(~ …)" and descendant selectors instead. */
.paged-doc { --memo-gutter: 32mm; padding-left: var(--memo-gutter); }
/* Rules run across both columns: the one under the address block, and any section rule. */
.paged-doc > hr { margin: 1.1em 0 1.9em calc(-1 * var(--memo-gutter)); border-top: 0.6pt solid var(--doc-text); }
/* Letterhead: a small square mark in the accent before the document title, in text ink. */
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-left .pagedjs_margin-content { display: flex; align-items: center; }
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-left .pagedjs_margin-content::before { content: ""; flex: none; width: 2.2mm; height: 2.2mm; margin-right: 2.6mm; background: var(--doc-accent); }
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-left { font-weight: 600; color: var(--doc-text); opacity: 1; }
/* Page numbers from page 2 on (DIN 5008 follow-up pages); a one-page memo has no footer. */
.pagedjs_pages .pagedjs_page.pagedjs_first_page .pagedjs_margin-bottom-right { visibility: hidden; }
/* To / From / Date / Subject: a paragraph that opens with a bold label, breaks into lines and comes before the rule. Labels hang in the label column, values line up with the text. */
.paged-doc > p:has(> strong:first-child):has(> br):has(~ hr) { margin: 0; }
.paged-doc > p:has(> strong:first-child):has(> br):has(~ hr) > strong { float: left; clear: left; width: var(--memo-gutter); margin-left: calc(-1 * var(--memo-gutter)); font-weight: 400; color: var(--doc-secondary); }
/* Side heads: section headings sit in the label column, level with the first line of their section. */
.paged-doc .markoto-section-heading { float: left; clear: left; width: calc(var(--memo-gutter) - 5mm); margin: 0 5mm 0 calc(-1 * var(--memo-gutter)); break-after: avoid; }
/* Tables: small reference grids in the text column; a firm rule under the header, hairlines between rows, tabular figures. */
.paged-doc table { font-size: 0.95em; font-variant-numeric: tabular-nums; width: 100%; margin: 0.7em 0 1.1em; }
.paged-doc th { font-weight: 600; vertical-align: bottom; }
.paged-doc thead tr { border-bottom: 0.75pt solid var(--doc-text); }
.paged-doc tbody tr { border-bottom: 0.4pt solid color-mix(in srgb, var(--doc-secondary) 60%, transparent); }
/* Signature: a paragraph after the rule that opens with a bold line and breaks into lines (name, title, company) gets room to sign above it. */
.paged-doc > p:has(> strong:first-child):has(> br):not(:has(~ hr)) { margin-top: 3.4em; }
/* cc line: a last paragraph set entirely in italics reads as distribution: small, upright, grey. */
.paged-doc > p:last-child:has(> em:only-child) { margin-top: 2.2em; font-size: 0.85em; color: var(--doc-secondary); }
.paged-doc > p:last-child > em:only-child { font-style: normal; }
`

/**
 * The theme a document gets when a preset is applied over `currentCss`
 * (its custom CSS so far). A built-in preset replaces every theme value;
 * the author's own custom CSS is kept. A preset may carry template CSS
 * (arXiv): it is placed first and the author's CSS after it, so the
 * author's rules still win. Template CSS of a previously applied preset
 * (an unchanged copy at the start of `currentCss`) is replaced, not
 * stacked — switching templates never accumulates their CSS.
 */
export function themeFromPreset(preset: ThemePreset, currentCss: string | undefined): DocTheme {
  const own = stripPresetCss(currentCss ?? '')
  const css = [preset.theme.customCss ?? '', own].map(c => c.trim()).filter(Boolean).join('\n\n')
  const theme: DocTheme = structuredClone(preset.theme)
  if (css) theme.customCss = css
  else delete theme.customCss
  return theme
}

function stripPresetCss(css: string): string {
  for (const p of THEME_PRESETS) {
    const template = p.theme.customCss?.trim()
    if (template && css.trimStart().startsWith(template)) return css.trimStart().slice(template.length)
  }
  return css
}

export const THEME_PRESETS: ThemePreset[] = [
  // — Markoto: the flagship preset and the in-app default. Brand
  // identity expressed through restraint — plain white paper, sumi-950
  // body text, Fraunces editorial headings at the major-third scale,
  // shu (vermillion) reserved for links and the blockquote rule. Left-
  // ragged body (calm field guide, not institutional academic), minimal
  // table borders, sharp image corners (print, not iOS), document-
  // matched mermaid, github-light code.
  {
    id: 'markoto',
    category: 'general',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 24 },
      meta: { font: 'JetBrains Mono' },
      body: { font: 'Inter', size: 10.5, lineHeight: 1.55, textAlign: 'left', color: '#14110D', background: '#FFFFFF', dropCap: true, firstLineIndent: false, paragraphSpacing: 0.6, hyphenate: false },
      headings: { font: 'Fraunces', scale: 1.28, weight: 500, underline: false, color: '#1F1B14', letterSpacing: -0.01, lineHeight: 1.25, spacingScale: 1.2, numbering: 'none', levels: {} },
      color: { brand: '#B5371F', secondary: '#A39A8A' },
      brand: { logoUrl: '/markoto-logos/primary-lockup-light.svg', logoHeight: 56 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page} · {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 9, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 92, blockquoteStyle: 'border', hrStyle: 'asterism', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Desaturated warm-paper admonition palette. Each hue keeps its
      // traditional meaning (blue/info, green/tip, purple/important,
      // amber/warning, red/caution) but drops ~40% saturation so the
      // boxes read as ink stamps on cream rather than LED indicators.
      // Caution borrows shu-500 — there's no AI seal in the printed
      // page so the brand red reads cleanly as "stop, look here".
      alerts: {
        note: '#3D5A80', // restrained slate blue
        tip: '#4A6F4D', // forest sage
        important: '#6B4F7F', // muted plum
        warning: '#9C7A2C', // warm ochre
        caution: '#B5371F' // shu-500
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: true, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Modern: clean Inter sans, blue accent, justified body, page
  // numbers in footer. The classic neutral starting point.
  {
    id: 'modern',
    category: 'general',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      meta: { font: 'Inter' },
      body: { font: 'Inter', size: 11, lineHeight: 1.3, textAlign: 'justify', color: '#111827', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.6, hyphenate: true },
      headings: { font: 'Inter', scale: 1.25, weight: 600, underline: false, color: '#111827', letterSpacing: -0.01, lineHeight: 1.2, spacingScale: 1, numbering: 'none', levels: {} },
      color: { brand: '#3B82F6', secondary: '#9ca3af' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page} / {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-dark', fontSize: 9, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'muted', headerTextColor: 'inherit', borders: 'all', zebra: false, cellPadding: 6, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // GitHub palette — the canonical look most users have seen in
      // README admonitions for years.
      alerts: {
        note: '#0969da',
        tip: '#1a7f37',
        important: '#8250df',
        warning: '#9a6700',
        caution: '#cf222e'
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Academic Paper: serif body, generous margins, dark-blue accent,
  // running head with title + page (no footer). Tables are minimal-
  // border (top/bottom rules only) — the academic convention. No cover
  // page: a title block (title, authors + affiliations, date, abstract)
  // opens page 1, sections are numbered.
  {
    id: 'academic',
    category: 'academic',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 22 },
      meta: { font: 'Source Serif 4' },
      body: { font: 'Source Serif 4', size: 10, lineHeight: 1.4, textAlign: 'justify', color: '#0f172a', background: '#FFFFFF', dropCap: false, firstLineIndent: true, paragraphSpacing: 0.4, hyphenate: true },
      headings: { font: 'Source Serif 4', scale: 1.2, weight: 600, underline: false, color: '#0f172a', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1, numbering: 'decimal', levels: {} },
      color: { brand: '#1e3a8a', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 2, columnGap: 7 },
      header: { left: '{title}', center: '', right: '{page}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'IBM Plex Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 90, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Academic restraint — slightly desaturated GitHub colours to
      // match the journal voice. Stay below the fold visually.
      alerts: {
        note: '#1f3a6e',
        tip: '#175c2e',
        important: '#5d3d99',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 4, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 1.7, subtitleSize: 1.1 }
    }
  },

  // — arXiv preprint: the kourgeorge/arxiv-style LaTeX template (MIT),
  // rebuilt from arxiv.sty — US Letter with 1in margins, Times
  // (TeX Gyre Termes) 10/11 justified, \parskip 5.5pt, numbered bold
  // sections at 12/10/10pt, a title block between 2pt rules in small
  // capitals at regular weight, "A Preprint" running head over a 0.4pt
  // rule, page number centred in the footer. The rest is template CSS
  // (ARXIV_TEMPLATE_CSS). Fixture: tests/fixtures/theme-shots/arxiv.md.
  {
    id: 'arxiv',
    category: 'academic',
    theme: {
      page: { size: 'Letter', orientation: 'portrait', margin: 25.4 },
      meta: { font: 'TeX Gyre Termes' },
      body: { font: 'TeX Gyre Termes', size: 10, lineHeight: 1.1, textAlign: 'justify', color: '#000000', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.55, hyphenate: true },
      headings: {
        font: 'TeX Gyre Termes',
        scale: 1.2,
        weight: 700,
        underline: false,
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 0.7,
        numbering: 'decimal',
        // \section \large (12pt), \subsection + \subsubsection \normalsize (10pt).
        levels: { h1: { size: 1.2 }, h2: { size: 1 }, h3: { size: 1 } }
      },
      color: { brand: '#000000', secondary: '#000000' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '{title}', right: 'A Preprint', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 10, font: 'Latin Modern Mono', background: 'none', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: true },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'rule', hrThickness: 1, figureLabel: true, referenceStyle: 'hanging' },
      mermaid: { theme: 'document' },
      // Ink-on-paper: admonitions are not part of the LaTeX look; keep
      // them dark and muted so they read as print.
      alerts: {
        note: '#1f3a6e',
        tip: '#175c2e',
        important: '#5d3d99',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: 'A Preprint', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: true, smallCaps: true, titleWeight: 400, showLogo: false, align: 'center', titleSize: 1.7, subtitleSize: 1 },
      customCss: ARXIV_TEMPLATE_CSS
    }
  },

  // — IEEE conference paper: the IEEEtran.cls conference template
  // (bare_conf.tex, LPPL), rebuilt from IEEEtran.cls in 10pt conference
  // mode — US Letter, two 21pc columns 1pc apart, Times (TeX Gyre
  // Termes) 10/12 justified and hyphenated with 1em indents, centred
  // small-caps sections "I. Introduction" and italic subsections
  // "A. …" at body size, a 24pt regular title over side-by-side author
  // blocks, the run-in "Abstract—" in 9pt bold opening the first
  // column, no running head or page number. The rest is template CSS
  // (IEEE_CONFERENCE_TEMPLATE_CSS). Fixture:
  // tests/fixtures/theme-shots/ieee-conference.md.
  {
    id: 'ieee-conference',
    category: 'academic',
    theme: {
      // \textwidth 43pc on Letter → 48pt (16.93mm) side margins;
      // \textheight 9.25in quantised to 56 lines (672pt): top 0.75in less
      // half the rounding = 51pt (17.99mm), bottom 69pt (24.34mm).
      page: { size: 'Letter', orientation: 'portrait', margin: 16.93, marginTop: 17.99, marginBottom: 24.34 },
      meta: { font: 'TeX Gyre Termes' },
      // \normalsize 10/12pt, \parskip 0, \parindent 1em.
      body: { font: 'TeX Gyre Termes', size: 10, lineHeight: 1.2, textAlign: 'justify', color: '#000000', background: '#FFFFFF', dropCap: false, firstLineIndent: true, paragraphSpacing: 0, hyphenate: true },
      headings: {
        font: 'TeX Gyre Termes',
        scale: 1.2,
        weight: 400,
        underline: false,
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 0.5,
        // \Roman. sections, \Alph. subsections, \arabic) subsubsections.
        numbering: 'ieee',
        // \section \normalsize\scshape centred, \subsection + \subsubsection \normalsize\itshape.
        levels: { h1: { size: 1, smallCaps: true, align: 'center' }, h2: { size: 1, style: 'italic' }, h3: { size: 1, style: 'italic' }, h4: { size: 1, style: 'italic' } }
      },
      color: { brand: '#000000', secondary: '#000000' },
      brand: { logoUrl: '', logoHeight: 48 },
      // \columnsep 1pc = 4.23mm.
      layout: { columns: 2, columnGap: 4.23 },
      // Conference mode: no running head, no page numbers (the publisher adds them).
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 8, font: 'Latin Modern Mono', background: 'none', frame: 'none', wrap: true, lineNumbers: false },
      // Caption above, numbered (the "TABLE I" format is template CSS); "Fig. 1." figures; [1] references.
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 2, captionPosition: 'above', captionLabel: true },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'rule', hrThickness: 1, figureLabel: true, referenceStyle: 'brackets' },
      mermaid: { theme: 'document' },
      // Ink-on-paper: IEEE has no admonitions; keep them dark and muted.
      alerts: {
        note: '#1f3a6e',
        tip: '#175c2e',
        important: '#5d3d99',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      // \Huge (24pt) regular title, centred; no date.
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 400, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1 },
      customCss: IEEE_CONFERENCE_TEMPLATE_CSS
    }
  },

  // — Technical documentation: printed developer docs (library guides,
  // API references, runbooks) in the O'Reilly / Sphinx-PDF tradition —
  // Source Serif 4 reading text, Source Sans 3 headings and furniture,
  // JetBrains Mono code in light, hairline-framed blocks. Numbered
  // sections, a compact title block with the TOC on page 1, running head
  // (title over a hairline) and dated page x / y footer. One ink-blue
  // accent; admonitions dark enough for greyscale print. Template CSS:
  // TECH_DOCS_TEMPLATE_CSS. Fixture: tests/fixtures/theme-shots/tech-docs.md.
  {
    id: 'tech-docs',
    category: 'engineering',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      meta: { font: 'Source Sans 3' },
      body: { font: 'Source Serif 4', size: 10, lineHeight: 1.4, textAlign: 'left', color: '#1b1f24', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.5, hyphenate: false },
      headings: { font: 'Source Sans 3', scale: 1.2, weight: 600, underline: false, color: '#111827', letterSpacing: 0, lineHeight: 1.25, spacingScale: 0.85, numbering: 'decimal', levels: {} },
      color: { brand: '#1d4f91', secondary: '#7b8594' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      // Running head: the guide's title, and the chapter the page is in.
      header: { left: '{title}', center: '', right: '{section}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true },
      footer: { left: '{date}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'IBM Plex Mono', background: 'tint', frame: 'box', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'none', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 2, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // GitHub's admonition hues, darkened so each stays legible as text
      // and distinct as a grey value in black-and-white print.
      alerts: {
        note: '#1d4f91',
        tip: '#1d6b3a',
        important: '#5b3a99',
        warning: '#8a5a00',
        caution: '#a3212b'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'left', titleSize: 2, subtitleSize: 1.15 },
      customCss: TECH_DOCS_TEMPLATE_CSS
    }
  },

  // — Business report: quarterly / annual reports, board updates, client
  // deliverables. Source Serif 4 headings over Inter 9.5/1.5 text, one deep
  // petrol accent used sparingly (cover rule, section bars, links, charts),
  // finance-style tables, a quiet footer over a thin rule, a left-aligned
  // cover. Template CSS: BUSINESS_REPORT_TEMPLATE_CSS. Fixtures:
  // tests/fixtures/theme-shots/business-report.md + proposal.md.
  {
    id: 'business-report',
    category: 'business',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 22 },
      meta: { font: 'Inter' },
      body: { font: 'Inter', size: 9.5, lineHeight: 1.5, textAlign: 'left', color: '#1E2329', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.75, hyphenate: false },
      headings: {
        font: 'Source Serif 4',
        scale: 1.25,
        weight: 600,
        underline: false,
        color: '#14202B',
        letterSpacing: -0.01,
        lineHeight: 1.2,
        spacingScale: 1.1,
        numbering: 'none',
        // A clear three-step hierarchy: 19 / 13.3 / 10.9 pt over 9.5 pt text.
        levels: { h1: { size: 2 }, h2: { size: 1.4 }, h3: { size: 1.15 } }
      },
      color: { brand: '#155A75', secondary: '#8A949E' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '{title}', center: '', right: '{page}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: true },
      code: { theme: 'github-light', fontSize: 8.5, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 3, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      alerts: {
        note: '#155A75',
        tip: '#3B6E4F',
        important: '#5B4A7E',
        warning: '#8F661C',
        caution: '#9E2A2B'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'none' },
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'left', titleSize: 3.6, subtitleSize: 1.35 },
      customCss: BUSINESS_REPORT_TEMPLATE_CSS
    }
  },

  // — Memo / business letter: a one- or two-page internal memo or letter
  // to print, sign or attach. A4 with DIN 5008-like margins (24 mm left,
  // 20 mm right) on a Swiss business-letter grid: labels (To / From / Date /
  // Subject) and side heads in a 32 mm column at the page margin, Inter
  // 10/15 text in a ~75-character column beside it. No cover, contents or
  // section numbers; the letterhead is the title beside a small accent
  // square, page numbers start on page 2. One signal-red accent, used only
  // for that mark. Template CSS: MEMO_TEMPLATE_CSS. Fixture:
  // tests/fixtures/theme-shots/memo.md.
  {
    id: 'memo',
    category: 'business',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20, marginTop: 30, marginRight: 20, marginBottom: 24, marginLeft: 24 },
      meta: { font: 'Inter' },
      body: { font: 'Inter', size: 10, lineHeight: 1.5, textAlign: 'left', color: '#1A1A1A', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.7, hyphenate: false },
      headings: {
        font: 'Inter',
        // The scale only sets the defaults; every level is pinned below.
        scale: 1.18,
        weight: 600,
        underline: false,
        color: '#1A1A1A',
        letterSpacing: 0,
        // Side heads share the text's 15 pt line, so they sit level with it.
        lineHeight: 1.5,
        spacingScale: 1,
        numbering: 'none',
        // A memo's headings are side heads at text size; deeper levels stay at text size too.
        levels: { h1: { size: 1 }, h2: { size: 1 }, h3: { size: 1 } }
      },
      color: { brand: '#C8102E', secondary: '#6E6E6E' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'none', zebra: false, cellPadding: 3, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Dark, desaturated hues: a callout in a memo must still read in greyscale print.
      alerts: {
        note: '#2F4F6F',
        tip: '#3B6147',
        important: '#57476F',
        warning: '#7F5E1E',
        caution: '#9E1F2A'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'left', titleSize: 2, subtitleSize: 1.15 },
      customCss: MEMO_TEMPLATE_CSS
    }
  },

  // — Novel: classic Crimson Text serif, deep violet accent, generous
  // line-height, only a centered page number in the footer. Tables and
  // code blocks rare in fiction — kept minimal.
  {
    id: 'novel',
    category: 'writing',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      meta: { font: 'Crimson Text' },
      body: { font: 'Crimson Text', size: 12, lineHeight: 1.5, textAlign: 'justify', color: '#1c1917', background: '#FFFFFF', dropCap: true, firstLineIndent: true, paragraphSpacing: 0.2, hyphenate: true },
      headings: { font: 'Crimson Text', scale: 1.22, weight: 600, underline: false, color: '#1c1917', letterSpacing: 0.01, lineHeight: 1.2, spacingScale: 1.4, numbering: 'none', levels: {} },
      color: { brand: '#4c1d95', secondary: '#a8a29e' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 10, font: 'IBM Plex Mono', background: 'none', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 80, blockquoteStyle: 'none', hrStyle: 'asterism', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Novel — admonitions are rare in fiction; if they appear they
      // should feel period-appropriate. Muted ink palette that reads
      // like marginalia in an old book.
      alerts: {
        note: '#3b3b6b',
        tip: '#2f5d3a',
        important: '#552d70',
        warning: '#7a5200',
        caution: '#7c1d1d'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Newsletter: 2-column layout, smaller body for density, sans body
  // (Karla) under serif headings (PT Serif), green accent, brand-color
  // table headers + zebra. Showcases the multi-column flow.
  {
    id: 'newsletter',
    category: 'writing',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 22 },
      meta: { font: 'PT Serif' },
      body: { font: 'Karla', size: 10, lineHeight: 1.45, textAlign: 'justify', color: '#18181b', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.5, hyphenate: true },
      headings: { font: 'PT Serif', scale: 1.22, weight: 700, underline: false, color: '#047857', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1, numbering: 'none', levels: {} },
      color: { brand: '#047857', secondary: '#a1a1aa' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 4, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'background', hrStyle: 'dashed', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Newsletter — bright, friendly admonition palette to match the
      // weekly-digest feel. Slightly more saturated than the reports.
      alerts: {
        note: '#0284c7',
        tip: '#16a34a',
        important: '#9333ea',
        warning: '#d97706',
        caution: '#dc2626'
      },
      toc: { maxDepth: 3, showTitle: false, showPageNumbers: false, leaderStyle: 'none' },
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Resume: one dense page. Inter at 10pt, a flat heading scale (h1
  // 1.64× body, h2 1.39×, h3 1.18×),
  // tight heading spacing, no running header, footer or cover, slate
  // accent. Made for the `resume` template (one A4 page).
  {
    id: 'resume',
    category: 'general',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 16 },
      meta: { font: 'Inter' },
      body: { font: 'Inter', size: 10, lineHeight: 1.4, textAlign: 'left', color: '#1f2933', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.45, hyphenate: false },
      headings: { font: 'Inter', scale: 1.18, weight: 600, underline: true, color: '#1e3a52', letterSpacing: 0, lineHeight: 1.2, spacingScale: 0.6, numbering: 'none', levels: {} },
      color: { brand: '#2f5b7c', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 3, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 2, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      alerts: {
        note: '#2f5b7c',
        tip: '#3e6b48',
        important: '#5c4a7a',
        warning: '#8a6a1f',
        caution: '#9a2f2a'
      },
      toc: { maxDepth: 2, showTitle: false, showPageNumbers: false, leaderStyle: 'none' },
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'left', titleSize: 2.4, subtitleSize: 1.15 }
    }
  }
]
