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
 * DESIGN_DOC_TEMPLATE_CSS — what the "Design doc / RFC" look needs beyond
 * theme fields: the metadata table under the title set as a document
 * header (labels in small caps, the status as a badge), decision records
 * (runs of paragraphs that open with a bold label: **D1.** …) on an accent
 * rule, comparison tables with a label column and a highlighted
 * proposed option, quiet inline code. Ordinary custom CSS
 * (tests/unit/themePresetCss.test.ts).
 */
const DESIGN_DOC_TEMPLATE_CSS = `/* Design doc / RFC template. */
/* Grid: prose in a ~75-character column; the rest of the text width is the review margin, which tables, code and diagrams may use. */
.paged-doc > p, .paged-doc > ul, .paged-doc > ol, .paged-doc > dl, .paged-doc > blockquote, .paged-doc > h1, .paged-doc > h2, .paged-doc > h3, .paged-doc > h4, .paged-doc > .markdown-alert { max-width: 122mm; }
.pagedjs_pages .pagedjs_page .pagedjs_footnote_area .footnote { max-width: 122mm; }
/* Title block: the subtitle (team · document type) is an eyebrow over the title. */
.paged-doc .markoto-title-block { display: flex; flex-direction: column; margin-bottom: 0.9em; }
.paged-doc .markoto-title-block .markoto-cover-subtitle { order: -1; margin: 0 0 5pt; font-style: normal; font-size: 0.82em; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--doc-secondary); }
.paged-doc .markoto-title-block .markoto-cover-title { margin: 0 0 6pt; max-width: 140mm; line-height: 1.15; letter-spacing: -0.01em; }
/* Document header: a two-column table without header labels (Status, Authors, Reviewers …) sits between two rules, without row lines. */
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) { width: 100%; margin: 0 0 1.8em; font-size: 0.92em; border-top: 1pt solid var(--doc-heading-color); border-bottom: 0.5pt solid var(--doc-secondary); }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) thead { display: none; }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) tr { border: 0; }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) td { padding: 1.6pt 0; vertical-align: baseline; }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) tr:first-child td { padding-top: 6pt; }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) tr:last-child td { padding-bottom: 6pt; }
/* Its labels: small caps in the muted grey at a fixed width, so the values form one column. */
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) td:first-child { width: 34mm; }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) td:first-child strong { font-weight: 500; font-variant-caps: all-small-caps; letter-spacing: 0.06em; color: var(--doc-secondary); }
/* The first row is the document's status: a dot and semibold text in the accent colour. */
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) tr:first-child td:last-child { font-weight: 600; color: var(--doc-accent); }
.paged-doc table:has(> thead th:first-child:empty):has(> thead th:nth-child(2):last-child:empty) tr:first-child td:last-child::before { content: ""; display: inline-block; width: 0.5em; height: 0.5em; margin-right: 0.5em; border-radius: 50%; background: var(--doc-accent); }
/* Section numbers in the accent colour for "see 3.2" in review comments. */
.paged-doc h1::before, .paged-doc h2::before, .paged-doc h3::before { color: var(--doc-accent); margin-right: 0.6em; }
/* Decision records: paragraphs that open with a bold label (D1., D2. …), two or more in a row, sit on an accent rule with the label in the accent. */
.paged-doc > p:has(> strong:first-child):has(+ p > strong:first-child), .paged-doc > p:has(> strong:first-child) + p:has(> strong:first-child) { padding: 0.15em 0 0.15em 0.9em; border-left: 2pt solid var(--doc-accent); }
.paged-doc > p:has(> strong:first-child):has(+ p > strong:first-child) > strong:first-child, .paged-doc > p:has(> strong:first-child) + p:has(> strong:first-child) > strong:first-child { color: var(--doc-accent); }
/* Tables: a step smaller, tabular figures, a firm rule under the header, hairlines between rows. */
.paged-doc table { font-size: 0.9em; line-height: 1.35; font-variant-numeric: tabular-nums; }
.paged-doc thead th { font-weight: 600; vertical-align: bottom; border-bottom: 0.75pt solid var(--doc-heading-color); }
/* Cells hold short phrases, identifiers and figures: no automatic hyphenation ("ac-counts", "docu-mented"). */
.paged-doc th, .paged-doc td { hyphens: manual; }
/* Comparison tables (an empty top-left cell): the first column holds the row labels. */
.paged-doc table:has(> thead th:first-child:empty) tbody td:first-child { font-weight: 600; color: var(--doc-heading-color); }
/* An option marked in bold in its header cell ("B … (proposed)") is the recommendation: accent text under an accent bar. */
.paged-doc thead th:has(strong) { color: var(--doc-accent); box-shadow: inset 0 2pt 0 var(--doc-accent); }
/* Task lists (open questions): a wrapped line continues under the text, not under the checkbox. */
.paged-doc li.task-list-item { padding-left: 2em; text-indent: -2em; }
/* Inline code: a faint tint without a box, never broken at a hyphen ("eu-" / "central"; a long span may run into the review margin); plain in table cells. */
.paged-doc :not(pre) > code { font-size: 0.88em; padding: 0.05em 0.2em; border: 0; white-space: nowrap; background: color-mix(in srgb, var(--doc-text) 6%, transparent); }
.paged-doc td code { background: none; padding: 0; white-space: normal; }
/* Links mostly point inside the document: accent text, no underline. */
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
 * RUNBOOK_TEMPLATE_CSS — what the on-call runbook look needs beyond theme
 * fields. A runbook is read under stress (3 a.m., second screen, a
 * printout): every rule here is about finding the next step and the next
 * command fast, and about surviving greyscale printing. Ordinary custom
 * CSS (tests/unit/themePresetCss.test.ts).
 */
const RUNBOOK_TEMPLATE_CSS = `/* On-call runbook template: scannable before elegant. */
/* Measure: prose and list text stop short of the right edge (~80 characters); commands and tables keep the full width. */
.paged-doc { --rb-overhang: 22mm; }
.paged-doc > p, .paged-doc > .markdown-alert, .paged-doc > blockquote { margin-right: var(--rb-overhang); }
.paged-doc > ol > li, .paged-doc > ul > li { padding-right: var(--rb-overhang); }
.paged-doc > ol > li > pre, .paged-doc > ol > li > .code-block, .paged-doc > ul > li > pre, .paged-doc > ul > li > .code-block { margin-right: calc(-1 * var(--rb-overhang)); }
/* Procedure steps: the number white on black in the left gutter, easy to find again after typing a command. */
.paged-doc > ol { padding-left: 2.2em; list-style: none; }
.paged-doc > ol > li { position: relative; margin: 0.5em 0; }
.paged-doc > ol > li::before { content: counter(list-item); position: absolute; left: -2.2em; top: -0.02em; min-width: 1.55em; padding: 0 0.15em; box-sizing: border-box; line-height: 1.4em; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; color: var(--doc-bg); background: var(--doc-heading-color); border-radius: 2pt; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
/* Checklists: real boxes with a firm outline (an unticked box must print), a filled box with a tick when done. Wrapped text hangs after the box. */
.paged-doc li.task-list-item { margin-left: -1.4em; padding-left: 1.4em; text-indent: -1.4em; }
.paged-doc li.task-list-item > * { text-indent: 0; }
.paged-doc li.task-list-item input[type="checkbox"] { appearance: none; -webkit-appearance: none; position: relative; width: 0.9em; height: 0.9em; margin: 0 0.3em 0 0; vertical-align: -0.13em; border: 1.1pt solid var(--doc-text); border-radius: 1.5pt; background: var(--doc-bg); text-indent: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
/* A ticked box is crossed, as on a paper checklist (a checkbox draws no ::after in Chromium, so the cross is two gradients). */
.paged-doc li.task-list-item input[type="checkbox"]:checked { background: linear-gradient(45deg, transparent 42%, var(--doc-text) 42% 58%, transparent 58%), linear-gradient(-45deg, transparent 42%, var(--doc-text) 42% 58%, transparent 58%), var(--doc-bg); }
/* Code: no programming ligatures — a runbook command must print exactly what is typed (JetBrains Mono turns |= into a turnstile). */
.paged-doc code, .paged-doc pre { font-variant-ligatures: none; font-feature-settings: "calt" 0; }
/* Inline commands: framed, not just tinted, so they stand apart from prose in greyscale; a wrapped command keeps its frame on both lines. */
.paged-doc :not(pre) > code { font-size: 0.84em; padding: 0.02em 0.25em; border: 0.5pt solid color-mix(in srgb, var(--doc-text) 40%, transparent); border-radius: 1.5pt; background: color-mix(in srgb, var(--doc-text) 5%, transparent); overflow-wrap: break-word; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
/* Shell blocks: compact leading; a wrapped line continues 4 columns in, so it can't be mistaken for a new command. */
.paged-doc pre { line-height: 1.35; margin: 0.6em 0; padding-top: 0.55em; padding-bottom: 0.55em; }
.paged-doc pre .code-line { min-height: 1.35em; padding-left: 4ch; text-indent: -4ch; }
/* A step is not split across pages: its command stays with the sentence that introduces it. */
.paged-doc > ol > li { break-inside: avoid; }
/* Sections open under a heavy rule across the full width: a printout shows where a section starts from arm's length. */
.paged-doc h1:not(.markoto-cover-title):not(.markoto-abstract-heading) { border-top: 2pt solid var(--doc-heading-color); padding-top: 4pt; }
/* Procedures (h2) sit on a grey band, the strongest landmark after a section. */
.paged-doc h2 { background: color-mix(in srgb, var(--doc-text) 9%, transparent); padding: 2.5pt 6pt; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.paged-doc h1::before, .paged-doc h2::before, .paged-doc h3::before { margin-right: 0.6em; }
/* Tables are looked up, not read: a step smaller, tabular figures, the first column (level, area, task) in bold as the row label. */
.paged-doc table { font-size: 0.9em; line-height: 1.25; font-variant-numeric: tabular-nums; margin: 0.7em 0; }
.paged-doc th { text-align: left; vertical-align: bottom; }
.paged-doc td { vertical-align: top; hyphens: manual; }
.paged-doc tbody td:first-child { font-weight: 700; }
.paged-doc td code { background: none; border: 0; padding: 0; }
/* Alerts: a hairline frame plus the coloured bar, and the kind as a dark label chip, so WARNING / CAUTION read in greyscale. */
.paged-doc .markdown-alert { border-radius: 0; border-top: 0.75pt solid var(--doc-text); border-right: 0.75pt solid var(--doc-text); border-bottom: 0.75pt solid var(--doc-text); border-left-width: 5pt; padding: 0.5em 0.8em; margin: 0.8em 0; }
.paged-doc .markdown-alert-title { display: inline-block; padding: 0.05em 0.45em; background: currentColor; -webkit-text-fill-color: var(--doc-bg); font-weight: 700; font-size: 0.8em; letter-spacing: 0.06em; margin-bottom: 0.35em; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
/* Links are cross-references to other procedures: ink, with a quiet underline. */
.paged-doc a { color: inherit; text-decoration-thickness: 0.5pt; text-underline-offset: 0.15em; }
`

/**
 * THESIS_TEMPLATE_CSS — the long-form academic look (Bachelor / Master /
 * PhD theses, long reports) beyond theme fields. Genre reference: LaTeX
 * `report` / `book` (report.cls, LPPL) as most university thesis classes
 * derive it — chapters open a new page under a large number, the running
 * head carries the chapter title and the page number, the opening page
 * shows only a page number at the foot (\thispagestyle{plain}).
 */
const THESIS_TEMPLATE_CSS = `/* Thesis template. Genre reference: LaTeX report.cls (LPPL), 11pt. */
/* \\chapter: every chapter (top-level heading) opens a new page, 50pt down; \\@makechapterhead puts the number on a line of its own, 20pt (\\huge) over the title, 40pt to the text. */
.paged-doc h1.markoto-section-heading { break-before: page; padding-top: 36pt; margin-bottom: 28pt; }
.paged-doc h1.markoto-section-heading:not(.unnumbered):not(.markoto-cover-title):not(.markoto-abstract-heading)::before { display: block; margin: 0 0 14pt; font-size: 2.1em; line-height: 1; font-weight: 400; color: var(--doc-accent); }
/* The chapter after the title page already starts a page. */
.paged-doc .markoto-cover + h1.markoto-section-heading { break-before: auto; }
/* \\tableofcontents: "Contents" set like a chapter title (\\chapter*) and ending its page; chapter entries bold with \\addvspace{1em} and no leaders; page numbers in the text colour. */
.paged-doc .table-of-contents { margin: 0; break-after: page; }
.paged-doc .table-of-contents::before { font-size: 2em; line-height: 1.2; padding-top: 36pt; margin-bottom: 28pt; }
.paged-doc .table-of-contents > ul > li { margin-top: 0.7em; }
.paged-doc .table-of-contents > ul > li::before { font-weight: 700; }
.paged-doc .table-of-contents > ul > li > a { font-weight: 700; }
.paged-doc .table-of-contents > ul > li > a::before { border-bottom-color: transparent; }
.paged-doc .table-of-contents a::after { color: var(--doc-text); }
/* \\section 1.1: the number, then a quad. */
.paged-doc h2::before, .paged-doc h3::before, .paged-doc h4::before { margin-right: 1em; }
/* \\pagestyle{headings}: chapter title + page number at the head (italic small caps here, not slanted capitals); no head on a chapter's opening page, only the page number centred at the foot (\\thispagestyle{plain}). */
.pagedjs_pages .pagedjs_page .pagedjs_margin-top { font-style: italic; font-variant-caps: all-small-caps; letter-spacing: 0.04em; }
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-right { font-style: normal; font-variant-caps: normal; letter-spacing: 0; }
.pagedjs_pages .pagedjs_page .pagedjs_margin { opacity: 1; }
.pagedjs_pages .pagedjs_page:has(h1.markoto-section-heading) .pagedjs_margin-top { visibility: hidden; }
.pagedjs_pages .pagedjs_page:not(:has(h1.markoto-section-heading)) .pagedjs_margin-bottom { visibility: hidden; }
/* titlepage: title at a third of the page, author in the middle, date at the foot; text-block margins. */
.paged-doc .markoto-cover { justify-content: flex-start; padding: 62mm 30mm 40mm; }
.paged-doc .markoto-cover-title { line-height: 1.15; margin-bottom: 0.9em; }
.paged-doc .markoto-cover-subtitle { font-style: normal; color: var(--doc-text); line-height: 1.4; max-width: 120mm; }
.paged-doc .markoto-cover-meta { flex: 1; margin-top: 18mm; font-family: var(--doc-body-font); color: var(--doc-text); }
.paged-doc .markoto-cover-author { font-family: var(--doc-body-font); font-size: 1.3em; }
.paged-doc .markoto-cover-date { margin-top: auto; font-family: var(--doc-body-font); font-size: 1.1em; letter-spacing: 0; text-transform: none; color: var(--doc-text); }
/* figure: \\abovecaptionskip 10pt, caption a step smaller than the text, centred under the image. */
.paged-doc figure { margin: 14pt 0; }
.paged-doc figure img { display: block; margin: 0 auto; }
.paged-doc figcaption { font: inherit; font-size: 0.9em; line-height: 1.3; color: inherit; margin: 8pt auto 0; max-width: 85%; text-align: center; text-wrap: pretty; }
/* table: caption above, booktabs rules (\\toprule and \\bottomrule heavier than \\midrule), no vertical lines, tabular figures. */
.paged-doc table > caption { font: inherit; font-size: 0.9em; color: inherit; padding-bottom: 6pt; }
.paged-doc table { font-size: 0.92em; line-height: 1.25; margin: 10pt auto; font-variant-numeric: lining-nums tabular-nums; }
.paged-doc table thead th { border-top: 0.8pt solid var(--doc-text); border-bottom: 0.5pt solid var(--doc-text); font-weight: 400; vertical-align: bottom; }
.paged-doc table tbody tr:last-child td { border-bottom: 0.8pt solid var(--doc-text); }
/* quote: indented on both sides, no rule; an attribution line after a dash stays roman. */
.paged-doc blockquote { margin: 10pt 2.5em; font-style: normal; }
/* description: bold term, the definition hanging 1.5em under it. */
.paged-doc dt { font-weight: 700; }
.paged-doc dd { margin-left: 1.5em; }
/* Bibliography: hanging indent (blocks.referenceStyle), a smaller step and a little space between entries. */
.paged-doc p.markoto-references { margin: 0 0 4pt; text-align: left; }
/* Listings: a hairline at the left in grey instead of the accent bar. */
.paged-doc pre { border-left-width: 0.75pt; border-left-color: var(--doc-secondary); }
/* Math at text size: KaTeX scales its Computer Modern by 1.21 to match other faces; next to Latin Modern that is a size too large. */
.paged-doc .katex { font-size: 1em; }
/* Abbreviations print as plain text (no dotted underline), in the text and in the footnotes. */
.pagedjs_pages abbr { text-decoration: none; }
/* hyperref: links print as plain text. */
.paged-doc a { text-decoration: none; color: inherit; }
`

/**
 * API_REFERENCE_TEMPLATE_CSS — what the "API reference" look needs beyond
 * theme fields: a prose measure narrower than the tables and code, resource
 * openers, endpoint lines (```http fences) as a findable band, small-caps
 * style section labels, status-code headings coloured by class, and dense
 * parameter tables with the parameter name in mono. Ordinary custom CSS
 * (tests/unit/themePresetCss.test.ts).
 */
const API_REFERENCE_TEMPLATE_CSS = `/* API reference template. Lookup material: sans text, mono identifiers, every endpoint a findable unit. */
/* Prose keeps a ~75-character measure; tables, code and endpoint lines use the full text width. */
.paged-doc > p, .paged-doc > ul, .paged-doc > ol, .paged-doc > blockquote, .paged-doc > .markdown-alert { max-width: 128mm; }
/* Resources (h1) open under a firm rule across the full width, so a new resource is visible from across the page. */
.paged-doc h1:not(.markoto-cover-title) { border-top: 1.5pt solid var(--doc-heading-color); padding-top: 5pt; }
/* Endpoint line: an http code fence holding "POST /payments" prints as a tinted band with an accent edge; the method stands a little apart from the path. */
.paged-doc pre:has(> code.language-http) { background: color-mix(in srgb, var(--doc-accent) 7%, transparent); border: 0; border-left: 2.5pt solid var(--doc-accent); border-radius: 0; padding: 4pt 8pt; font-size: 9pt; font-weight: 600; word-spacing: 0.45em; color: var(--doc-heading-color); }
.paged-doc pre > code.language-http { font-weight: 600; }
/* Section labels inside an endpoint (Parameters, Request, Response): small, spaced capitals over a hairline. */
.paged-doc h3 { text-transform: uppercase; letter-spacing: 0.08em; color: var(--doc-secondary); padding-bottom: 2pt; border-bottom: 0.5pt solid color-mix(in srgb, var(--doc-secondary) 45%, transparent); }
/* Status headings (200 OK, 402 Payment Required) in mono, with a mark coloured by status class (from the heading id, "h-200-ok"); the code itself carries the meaning in greyscale. */
.paged-doc h4 { font-family: var(--doc-mono-font); }
.paged-doc h4[id^="h-2"]::before, .paged-doc h4[id^="h-4"]::before, .paged-doc h4[id^="h-5"]::before { content: ""; display: inline-block; width: 0.55em; height: 0.55em; margin-right: 0.45em; border-radius: 50%; vertical-align: 0.05em; }
.paged-doc h4[id^="h-2"]::before { background: #2f7d4a; }
.paged-doc h4[id^="h-4"]::before { background: #b26a00; }
.paged-doc h4[id^="h-5"]::before { background: #b42a2a; }
/* Inline code: a faint tint, tight padding; plain inside headings. */
.paged-doc :not(pre) > code { font-size: 0.88em; padding: 0.05em 0.25em; border-radius: 1.5pt; background: color-mix(in srgb, var(--doc-text) 6%, transparent); }
.paged-doc h1 code, .paged-doc h2 code, .paged-doc h3 code, .paged-doc h4 code { background: none; padding: 0; font-size: 0.92em; }
/* Code blocks: compact leading for JSON; a wrapped line continues 4 columns in. */
.paged-doc pre { line-height: 1.35; }
.paged-doc pre .code-line { padding-left: 4ch; text-indent: -4ch; }
/* Reference tables: a step smaller, tabular figures, top-aligned cells, hairline rows. */
.paged-doc table { font-size: 0.92em; line-height: 1.35; font-variant-numeric: tabular-nums; }
.paged-doc th, .paged-doc td { vertical-align: top; hyphens: manual; }
.paged-doc thead th { font-weight: 600; text-align: left; }
.paged-doc td code, .paged-doc th code { background: none; padding: 0; font-size: 0.92em; }
/* Identifiers never break inside (the engine's "anywhere" split "invalid_re / quest"); a cell breaks between them. */
.paged-doc td code { white-space: nowrap; }
/* The first column names the thing (parameter, field, key prefix): mono, medium weight, heading ink. */
.paged-doc td:first-child code { font-weight: 500; color: var(--doc-heading-color); }
/* Rules: a firm one under the header, hairlines between rows, a closing rule. */
.paged-doc thead tr { border-bottom: 0.75pt solid var(--doc-text); }
.paged-doc tbody tr { border-bottom: 0.4pt solid color-mix(in srgb, var(--doc-secondary) 40%, transparent); }
.paged-doc tbody tr:last-child { border-bottom: 0.75pt solid var(--doc-text); }
/* Admonitions: square, a thin rule, the title in spaced capitals. */
.paged-doc .markdown-alert { border-left-width: 2.5pt; border-radius: 0; padding: 0.45em 0.9em; }
.paged-doc .markdown-alert-title { font-size: 0.82em; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 0.2em; }
/* Contents: resources semibold, endpoints regular under them. */
.paged-doc .table-of-contents > ul > li > a { font-weight: 600; }
/* Links are cross-references: accent, no underline. */
.paged-doc a { text-decoration: none; }
/* Running head: the resource the page is in, in the heading weight. */
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-left { font-weight: 600; }
`

/**
 * LECTURE_NOTES_TEMPLATE_CSS — what the lecture-notes handout needs beyond
 * theme fields (reference: LaTeX `article` 11pt + amsthm, typeset as
 * handouts are: a compact title block, theorem environments, a wide
 * annotation margin). The fixture convention it styles: IMPORTANT alerts
 * are theorems, NOTE alerts remarks, TIP intuition, WARNING / CAUTION
 * pitfalls; a bold run-in label ("**Theorem 7.3 (linearity).**") names
 * the environment. Ordinary custom CSS (tests/unit/themePresetCss.test.ts).
 */
const LECTURE_NOTES_TEMPLATE_CSS = `/* Lecture notes / course handout (LaTeX article 11pt + amsthm). */
/* Title block = a handout's \\maketitle: course line in small caps over the title, lecturer left and date right on one line, closed by a rule. */
.paged-doc .markoto-title-block { display: grid; grid-template-columns: 1fr auto; column-gap: 1em; padding-bottom: 5pt; border-bottom: 0.6pt solid; margin-bottom: 6pt; }
.paged-doc .markoto-title-block > * { grid-column: 1 / -1; }
.paged-doc .markoto-title-block .markoto-cover-subtitle { grid-row: 1; margin: 0 0 4pt; font-style: normal; font-variant-caps: all-small-caps; letter-spacing: 0.06em; }
.paged-doc .markoto-title-block .markoto-cover-title { grid-row: 2; margin: 0 0 8pt; line-height: 1.15; }
.paged-doc .markoto-title-block .markoto-cover-authors { grid-row: 3; grid-column: 1; margin: 0; }
.paged-doc .markoto-title-block .markoto-cover-author { font-weight: 400; }
.paged-doc .markoto-title-block .markoto-cover-date { grid-row: 3; grid-column: 2; align-self: end; margin: 0; }
/* \\@startsection: the section number, then a quad. */
.paged-doc h1::before, .paged-doc h2::before, .paged-doc h3::before { margin-right: 1em; }
/* Running head (\\pagestyle{headings}): the current section in italics left, the page number right. */
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-left { font-style: italic; }
/* KaTeX sets math in Computer Modern, the body is Latin Modern (the same design): no size step between inline math and text. */
.paged-doc .katex { font-size: 1em; }
.paged-doc .katex-display { margin: 0.7em 0; }
/* A display wider than the measure runs into the annotation margin (an overfull box) instead of being clipped in print. */
.paged-doc .katex-display { overflow: visible; }
/* amsthm environments, not callouts: square, no tint, the kind's name as a small-caps label (Note, Tip, Warning …). */
.paged-doc .markdown-alert { border-radius: 0; background: none; border-left-width: 1.2pt; padding: 0.15em 0 0.15em 0.9em; margin: 0.9em 0; }
.paged-doc .markdown-alert-title { font-size: 1em; font-weight: 700; text-transform: none; letter-spacing: 0.03em; font-variant-caps: small-caps; margin: 0 0 0.15em; }
/* An environment that opens with its own bold label (**Theorem 7.3 (linearity).**, **Remark.**) needs no kind name above it. */
.paged-doc .markdown-alert-important:has(> p:nth-child(2) > strong:first-child) > .markdown-alert-title { display: none; }
.paged-doc .markdown-alert-note:has(> p:nth-child(2) > strong:first-child) > .markdown-alert-title { display: none; }
.paged-doc .markdown-alert > p:nth-child(2) { margin-top: 0; }
/* Theorem (IMPORTANT), amsthm "plain" style: framed, italic statement, upright bold label. */
.paged-doc .markdown-alert-important { border: 0.6pt solid var(--doc-accent); border-left-width: 2.4pt; background: color-mix(in srgb, var(--doc-accent) 5%, transparent); padding: 0.55em 0.9em; font-style: italic; }
.paged-doc .markdown-alert-important strong:first-child { font-style: normal; }
/* Pitfalls (WARNING, CAUTION): a hairline box, upright text. */
.paged-doc .markdown-alert-warning, .paged-doc .markdown-alert-caution { border-width: 0.6pt; border-style: solid; border-left-width: 2.4pt; padding: 0.55em 0.9em; }
/* Definitions (definition list): bold term, the definition indented under it, never parted at a page break. */
.paged-doc dl { margin: 0.9em 0; }
.paged-doc dt { font-weight: 700; margin-top: 0.7em; break-after: avoid; }
.paged-doc dd { margin: 0.15em 0 0 1.5em; }
/* Lists: \\leftmargini 2.5em; exercise sub-parts (a), (b), (c) as in LaTeX enumerate level 2, indented under their exercise; \\itemsep of a few points. */
.paged-doc ul, .paged-doc ol { padding-left: 1.9em; }
.paged-doc ol ol { padding-left: 2.2em; margin: 0.25em 0; }
.paged-doc ol ol > li::marker { content: "(" counter(list-item, lower-alpha) ")\\a0"; }
.paged-doc li { margin: 0.25em 0; }
/* \\texttt: typewriter, no box; listings: keywords in bold, no colour (prints in black and white). */
.paged-doc :not(pre) > code { background: none; padding: 0; border: 0; font-size: 0.95em; }
.paged-doc pre .hljs-keyword, .paged-doc pre .hljs-built_in { font-weight: 700; }
/* Listings box: a line of air above and below the code, not more. */
.paged-doc pre { padding: 0.55em 0.9em; }
/* ==Highlights== as a light marker that still reads in greyscale; abbreviations print without the screen's dotted underline. */
.paged-doc mark { background: color-mix(in srgb, var(--doc-accent) 13%, transparent); }
.paged-doc abbr { text-decoration: none; }
/* booktabs: \\toprule and \\bottomrule heavier than \\midrule, figures in lining tabular digits. */
.paged-doc table { width: auto; margin: 0.9em auto; font-variant-numeric: lining-nums tabular-nums; }
.paged-doc table thead th { border-top: 0.8pt solid; border-bottom: 0.5pt solid; font-weight: 700; }
.paged-doc table tbody tr:last-child td { border-bottom: 0.8pt solid; }
.paged-doc th, .paged-doc td { padding: 1.5pt 8pt; }
/* hyperref with hidelinks: links read as text. */
.paged-doc a { text-decoration: none; }
`

/**
 * ESSAY_TEMPLATE_CSS — the part of the APA 7 student paper no theme field
 * expresses (Publication Manual of the APA, 7th ed.; checked against
 * apa7.cls in `stu` mode). Letter page with 1in margins, Termes 12 pt
 * double-spaced and ragged right, bold headings at text size (centred /
 * flush left / bold italic), the page number top right, the hanging
 * reference list and the title block are theme values.
 */
const ESSAY_TEMPLATE_CSS = `/* APA 7 student paper. Values from the Publication Manual (7th ed.) §2.3–2.28 and §8.27; apa7.cls (stu mode) as the check. */
/* §2.24: indent the first line of every paragraph 0.5 in, the first after a heading too. */
.paged-doc > p, .paged-doc > p + p { text-indent: 0.5in; }
/* §2.21 + §2.27: everything double-spaced, headings included, no extra space around them. */
.paged-doc h1, .paged-doc h2, .paged-doc h3, .paged-doc h4, .paged-doc h5 { line-height: 2; margin: 0; }
/* §2.27: Level 4 and 5 are indented 0.5 in (bold, bold italic). */
.paged-doc h4, .paged-doc h5 { text-indent: 0.5in; }
/* §2.3 title page: the title 3–4 double-spaced lines down, one blank line, then author, affiliation, course, instructor, date, each on its own double-spaced line; the text starts on page 2. */
.paged-doc .markoto-title-block { padding-top: 96pt; margin: 0; break-after: page; }
.paged-doc .markoto-title-block .markoto-cover-title { line-height: 2; margin: 0 0 24pt; }
.paged-doc .markoto-title-block .markoto-cover-authors { display: block; margin: 0; }
.paged-doc .markoto-title-block .markoto-cover-author { font-weight: 400; }
.paged-doc .markoto-title-block .markoto-cover-affiliation { line-height: 2; }
.paged-doc .markoto-title-block .markoto-cover-date { margin: 0; }
/* §2.18: the page number top right on every page, the title page included, in the text font and size. */
.pagedjs_pages .pagedjs_page.pagedjs_first_page .pagedjs_margin-top-right > .pagedjs_margin-content::after { content: counter(page); }
.pagedjs_pages .pagedjs_page .pagedjs_margin-top-right { font-size: 12pt; color: var(--doc-text); opacity: 1; }
/* §2.19: footnotes in the word processor's default, 10 pt single-spaced. */
.paged-doc .footnote { font-size: 10pt; line-height: 1.2; }
/* §8.27: a block quotation is indented 0.5 in as a block, double-spaced, no quotation marks, no extra space. */
.paged-doc blockquote { margin: 0 0 0 0.5in; font-style: normal; }
.paged-doc blockquote p { text-indent: 0; margin: 0; }
/* §2.12 + §9.43: the reference list starts on a new page; entries double-spaced with a 0.5 in hanging indent. */
.paged-doc .markoto-references-heading { break-before: page; }
.paged-doc p.markoto-references { --doc-reference-indent: 0.5in; margin: 0; }
/* §9.35: DOIs and URLs print as plain text. */
.paged-doc a { color: inherit; text-decoration: none; }
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
 * PROPOSAL_TEMPLATE_CSS — what the client-proposal look needs beyond theme
 * fields: the cover panel, the "01" section index, invoice-style pricing
 * tables (ruled subtotal, double-ruled grand total), the key/value facts
 * table and the signature block. Same rules as the other template CSS
 * (sanitised, editable by the author).
 */
const PROPOSAL_TEMPLATE_CSS = `/* Client proposal template. */
/* Cover: a tall warm panel (the banner band) with the title set low in it over an accent rule; who it is for under the panel, who sends it and when at the foot. Insets follow the page margins (32 / 30 mm). */
.paged-doc .markoto-cover { grid-template-rows: auto minmax(150mm, auto) auto 1fr auto; }
.paged-doc .markoto-cover::before { background: color-mix(in srgb, var(--doc-brand) 7%, color-mix(in srgb, var(--doc-secondary) 14%, var(--doc-bg))); border-bottom: 3pt solid var(--doc-brand); }
.paged-doc .markoto-cover-logo { padding: 24mm 30mm 0 32mm; }
.paged-doc .markoto-cover-title { align-self: end; padding: 0 30mm 14mm 32mm; line-height: 1.08; letter-spacing: -0.015em; }
.paged-doc .markoto-cover-subtitle { font-style: normal; font-weight: 500; color: var(--doc-brand); padding: 10mm 30mm 0 32mm; }
.paged-doc .markoto-cover-meta { padding: 0 30mm 26mm 32mm; font-size: 0.95em; }
.paged-doc .markoto-cover-author { font-weight: 600; color: var(--doc-heading-color); }
/* Sections: a small accent index ("01") over each top-level heading, the proposal's contents in miniature (decorative; headings.numbering stays off). */
.paged-doc h1.markoto-section-heading:not(.unnumbered) { counter-increment: mk-proposal; }
.paged-doc h1.markoto-section-heading:not(.unnumbered)::before { content: counter(mk-proposal, decimal-leading-zero); display: block; margin-bottom: 0.45em; font-family: var(--doc-body-font); font-size: 0.42em; font-weight: 600; letter-spacing: 0.12em; color: var(--doc-brand); font-variant-numeric: lining-nums tabular-nums; }
/* The first paragraph of a section is its lead: a step larger, in heading ink. */
.paged-doc > h1 + p { font-size: 1.1em; line-height: 1.45; color: var(--doc-heading-color); }
.paged-doc h1 + h2 { margin-top: 0; }
/* Tables read like an invoice: a step smaller, tabular figures in the amount columns, a firm rule under the header, hairlines between line items. */
.paged-doc table { font-size: 0.93em; line-height: 1.35; margin: 1.1em 0 1.4em; }
.paged-doc td, .paged-doc th { vertical-align: baseline; }
.paged-doc td[style*="right"], .paged-doc th[style*="right"] { font-variant-numeric: lining-nums tabular-nums; }
.paged-doc th { font-size: 0.86em; font-weight: 600; letter-spacing: 0.03em; color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg)); vertical-align: bottom; }
.paged-doc tr { border-bottom: 0.5pt solid color-mix(in srgb, var(--doc-secondary) 45%, transparent); }
.paged-doc thead tr { border-bottom: 0.75pt solid var(--doc-heading-color); }
/* Subtotal and total: a row whose label is bold, after a plain row, gets a rule above it. */
.paged-doc tbody tr:not(:has(> td:first-child > strong)) + tr:has(> td:first-child > strong) > td { border-top: 0.75pt solid var(--doc-heading-color); }
/* The grand total (a bold last row after line items): a step larger, closed by the bookkeeper's double rule. */
.paged-doc tbody tr:not(:has(> td:first-child > strong)) ~ tr:last-child:has(> td:first-child > strong) { font-size: 1.1em; border-bottom: 2.5pt double var(--doc-heading-color); }
/* A table with an empty header row is a key/value list (prepared for / by, reference, validity): no header, quiet labels, a rule above and below. */
.paged-doc thead tr:not(:has(> th:not(:empty))) { display: none; }
.paged-doc table:has(> thead > tr > th:first-child:empty) { border-top: 0.75pt solid var(--doc-heading-color); border-bottom: 0.75pt solid var(--doc-heading-color); }
.paged-doc table:has(> thead > tr > th:first-child:empty) td:first-child { width: 26%; font-size: 0.86em; letter-spacing: 0.03em; color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg)); }
.paged-doc table:has(> thead > tr > th:first-child:empty) td:first-child strong { font-weight: 600; }
/* Signature block: in a table, a row of empty cells is a line to sign on and the row under it its caption (name, role, "Place, date"). The block never splits (the engine would split a short table to fill a page). */
.paged-doc table:has(td:first-child:empty) { table-layout: fixed; break-inside: avoid !important; }
.paged-doc table:has(td:first-child:empty) tr { border: 0; }
.paged-doc table:has(td:first-child:empty) th { font-size: 1em; letter-spacing: 0; color: var(--doc-heading-color); }
.paged-doc table:has(td:first-child:empty) th, .paged-doc table:has(td:first-child:empty) td { padding-left: 0; }
.paged-doc tr:has(> td:first-child:empty):has(> td:last-child:empty) > td { height: 12mm; padding: 0; background: linear-gradient(var(--doc-text), var(--doc-text)) left bottom / calc(100% - 12mm) 0.75pt no-repeat; }
.paged-doc tr:has(> td:first-child:empty):has(> td:last-child:empty) + tr > td { padding-top: 0.35em; font-size: 0.86em; color: color-mix(in srgb, var(--doc-text) 70%, var(--doc-bg)); }
/* Callouts: square, a thin rule, a step smaller than the text. */
.paged-doc .markdown-alert { border-left-width: 2pt; border-radius: 0; padding: 0.8em 1.1em; font-size: 0.94em; }
/* Numbered lists (the problems, the terms): numbers in the accent; sub-clauses a, b, c as in a contract. */
.paged-doc ol > li::marker { color: var(--doc-brand); font-weight: 600; }
.paged-doc ol ol { list-style-type: lower-alpha; }
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
  // — Lecture notes: a course handout in the LaTeX tradition (article
  // 11pt + amsthm, KOMA-style generous margins). Latin Modern Roman so
  // text and KaTeX's Computer Modern math are one design; A4 with a wide
  // right margin for students' annotations (139 mm measure, ~75
  // characters at 11 pt); numbered bold sections at \Large / \large /
  // \normalsize; a compact title block (course, title, lecturer, date)
  // over a rule; the section in the running head. Theorem environments
  // from alerts and bold run-in labels, (a)/(b) exercise parts, booktabs
  // tables and black-and-white listings are template CSS
  // (LECTURE_NOTES_TEMPLATE_CSS). One ink-blue accent. Fixture:
  // tests/fixtures/theme-shots/lecture-notes.md.
  {
    id: 'lecture-notes',
    category: 'academic',
    theme: {
      // geometry: 25 mm top/left, 46 mm right (annotation margin), 27 mm bottom.
      page: { size: 'A4', orientation: 'portrait', margin: 25, marginRight: 46, marginBottom: 27 },
      meta: { font: 'Latin Modern Roman' },
      // 11/14pt (\normalsize 11pt with \baselineskip 13.6pt, opened up a
      // little for inline fractions and handwritten notes); half-line
      // \parskip instead of an indent (KOMA parskip=half).
      body: { font: 'Latin Modern Roman', size: 11, lineHeight: 1.27, textAlign: 'justify', color: '#000000', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.5, hyphenate: true },
      headings: {
        font: 'Latin Modern Roman',
        scale: 1.2,
        weight: 700,
        underline: false,
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 0.9,
        numbering: 'decimal',
        // \section \Large (14.4pt), \subsection \large (12pt), \subsubsection \normalsize.
        levels: { h1: { size: 1.31 }, h2: { size: 1.09 }, h3: { size: 1 } }
      },
      color: { brand: '#1f3a6e', secondary: '#555555' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      // \pagestyle{headings}: section left, page right, over a hairline; nothing at the foot.
      header: { left: '{section}', center: '', right: '{page}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      // Listings: Latin Modern Mono at \small, no colour, a light tint and an accent rule.
      code: { theme: 'none', fontSize: 9.5, font: 'Latin Modern Mono', background: 'tint', frame: 'rule', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: true },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: true, referenceStyle: 'hanging' },
      mermaid: { theme: 'document' },
      // Theorems in the accent; remarks and intuition in grey; pitfalls
      // dark amber / red — all distinct grey values in black-and-white print.
      alerts: {
        note: '#555555',
        tip: '#555555',
        important: '#1f3a6e',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      // \LARGE (17.28pt) bold title, left-aligned; course as the subtitle, lecturer + date.
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 700, showLogo: false, align: 'left', titleSize: 1.57, subtitleSize: 1 },
      customCss: LECTURE_NOTES_TEMPLATE_CSS
    }
  },

  // — Thesis: long-form academic writing (Bachelor / Master / PhD theses,
  // long reports) in the LaTeX report/book tradition (report.cls 11pt,
  // LPPL) — A4, Latin Modern Roman 11/14 justified and hyphenated with
  // first-line indents, a ~70-character measure inside generous margins,
  // chapters on a new page under a large number, decimal sections 1.1 /
  // 1.1.1, a classic title page, chapter title + page number in the
  // running head, booktabs tables, hanging-indent references. The rest is
  // template CSS (THESIS_TEMPLATE_CSS). Fixture:
  // tests/fixtures/theme-shots/thesis-chapter.md.
  {
    id: 'thesis',
    category: 'academic',
    theme: {
      // report.cls 11pt on A4: \textwidth 360pt (127mm). A touch wider
      // here (130mm ≈ 70 characters); top/bottom leave room for the head.
      page: { size: 'A4', orientation: 'portrait', margin: 40, marginTop: 35, marginBottom: 38 },
      meta: { font: 'Latin Modern Roman' },
      // \normalsize 11/13.6pt, \parskip 0, \parindent 1.5em (engine: 1.2em).
      body: { font: 'Latin Modern Roman', size: 11, lineHeight: 1.28, textAlign: 'justify', color: '#111111', background: '#FFFFFF', dropCap: false, firstLineIndent: true, paragraphSpacing: 0, hyphenate: true },
      headings: {
        font: 'Latin Modern Roman',
        scale: 1.26,
        weight: 700,
        underline: false,
        color: '#111111',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 1,
        numbering: 'decimal',
        // \chapter \Huge (the title at 2 × body), \section \Large, \subsection \large, \subsubsection \normalsize.
        levels: { h1: { size: 2 }, h2: { size: 1.3 }, h3: { size: 1.1 }, h4: { size: 1 } }
      },
      color: { brand: '#24456b', secondary: '#6b6b6b' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      // \pagestyle{headings}: chapter title left, page number right; the
      // footer number shows only on chapter opening pages (template CSS).
      header: { left: '{section}', center: '', right: '{page}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 9.5, font: 'Latin Modern Mono', background: 'none', frame: 'rule', wrap: true, lineNumbers: false },
      // Captions are written by the author ("Table 3.1: …", chapter-relative), above tables.
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 3, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'asterism', hrThickness: 1, figureLabel: false, referenceStyle: 'hanging' },
      mermaid: { theme: 'document' },
      // Ink-on-paper: dark, muted admonitions that survive greyscale print.
      alerts: {
        note: '#1f3a6e',
        tip: '#175c2e',
        important: '#5d3d99',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      // titlepage: \Huge bold title, author, date at the foot; no running head.
      cover: { enabled: true, layout: 'classic', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 700, showLogo: true, align: 'center', titleSize: 2.3, subtitleSize: 1.2 },
      customCss: THESIS_TEMPLATE_CSS
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
  // — API reference: printed/PDF reference for an HTTP API (Stripe-like
  // clarity in print). Lookup material, not reading text: IBM Plex Sans
  // 9.5/1.45 throughout with IBM Plex Mono for every identifier, prose held
  // to ~75 characters while parameter tables and JSON use the full width,
  // unnumbered resources (h1) under a firm rule, endpoints (h2) with their
  // "POST /path" line as an accent band (```http fence), spaced-capital
  // section labels (h3), mono status headings (h4). Running head: the
  // resource the page is in ({section}) and the title. Template CSS:
  // API_REFERENCE_TEMPLATE_CSS. Fixture: tests/fixtures/theme-shots/api-reference.md.
  {
    id: 'api-reference',
    category: 'engineering',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 18, marginTop: 20 },
      meta: { font: 'IBM Plex Sans' },
      body: { font: 'IBM Plex Sans', size: 9.5, lineHeight: 1.45, textAlign: 'left', color: '#1f2328', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.55, hyphenate: false },
      headings: {
        font: 'IBM Plex Sans',
        scale: 1.2,
        weight: 600,
        underline: false,
        color: '#14171c',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 0.8,
        numbering: 'none',
        // Resource 16.6pt, endpoint 12.4pt, section label 8pt caps, status code 9.5pt mono.
        levels: { h1: { size: 1.75 }, h2: { size: 1.3 }, h3: { size: 0.84 } }
      },
      color: { brand: '#3a3f9e', secondary: '#5f6673' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      // The resource the page is in (where the eye lands first), and the title.
      header: { left: '{section}', center: '', right: '{title}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true },
      footer: { left: '', center: '{page} / {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8, font: 'IBM Plex Mono', background: 'tint', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'muted', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Admonition hues dark enough to stay distinct grey values in print.
      alerts: {
        note: '#3a3f9e',
        tip: '#2f6b3f',
        important: '#5b3a99',
        warning: '#8a5a00',
        caution: '#a3212b'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 600, showLogo: false, align: 'left', titleSize: 2.1, subtitleSize: 1.1 },
      customCss: API_REFERENCE_TEMPLATE_CSS
    }
  },

  // — Design doc / RFC: engineering design documents, RFCs, ADRs and
  // technical proposals — read once, carefully, and argued about. IBM Plex
  // Sans 10/14.5 in a ~75-character column with a deeper right margin for
  // review notes on the printout, numbered sections ("see 3.2"), one muted
  // indigo accent (section numbers, status, decision records, the proposed
  // option), the doc title + current section as a quiet running head,
  // lightly tinted IBM Plex Mono code. Template CSS:
  // DESIGN_DOC_TEMPLATE_CSS. Fixture: tests/fixtures/theme-shots/design-doc.md.
  {
    id: 'design-doc',
    category: 'engineering',
    theme: {
      // 166 mm text width: prose takes 122 mm of it (~75 characters, template CSS), the rest is the review margin.
      page: { size: 'A4', orientation: 'portrait', margin: 22 },
      meta: { font: 'IBM Plex Sans' },
      body: { font: 'IBM Plex Sans', size: 10, lineHeight: 1.45, textAlign: 'left', color: '#1F2328', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.65, hyphenate: false },
      headings: {
        font: 'IBM Plex Sans',
        scale: 1.2,
        weight: 600,
        underline: false,
        color: '#15171C',
        letterSpacing: -0.005,
        lineHeight: 1.25,
        spacingScale: 0.8,
        numbering: 'decimal',
        // A quiet three-step hierarchy: 16 / 12.5 / 10.5 pt over 10 pt text.
        levels: { h1: { size: 1.6 }, h2: { size: 1.25 }, h3: { size: 1.05 } }
      },
      color: { brand: '#3A428C', secondary: '#7D828C' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      // Running head: what the page is and where in the argument it stands.
      header: { left: '{title}', center: '', right: '{section}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '{date}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'IBM Plex Mono', background: 'tint', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Muted, print-safe admonition hues; note follows the accent.
      alerts: {
        note: '#3A428C',
        tip: '#2E6B47',
        important: '#6B3F8F',
        warning: '#8A5B12',
        caution: '#A12C2C'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 600, showLogo: false, align: 'left', titleSize: 2.2, subtitleSize: 1 },
      customCss: DESIGN_DOC_TEMPLATE_CSS
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
  // — Client proposal: agencies, consultants and freelancers sending a
  // proposal or quote. Warmer and more personal than the corporate report:
  // Lora headings (a calligraphic serif, set at 500 on the cover) over
  // Work Sans 10/1.5 text in a 148 mm column (about 75 characters), one
  // rust accent that greys to a dark tone in print, a tall warm cover
  // panel, invoice-style pricing tables, an accent "01" index over every
  // section and a signature block drawn from a table (a row of empty
  // cells is a line to sign on). Footer: title and "page / pages" (the
  // client can see the document is complete). Template CSS:
  // PROPOSAL_TEMPLATE_CSS. Fixture: tests/fixtures/theme-shots/proposal.md.
  {
    id: 'proposal',
    category: 'business',
    theme: {
      // Generous margins, a slightly wider inner (left) margin.
      page: { size: 'A4', orientation: 'portrait', margin: 26, marginTop: 24, marginRight: 30, marginBottom: 26, marginLeft: 32 },
      meta: { font: 'Work Sans' },
      body: { font: 'Work Sans', size: 10, lineHeight: 1.5, textAlign: 'left', color: '#2B2622', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.7, hyphenate: false },
      headings: {
        font: 'Lora',
        scale: 1.25,
        weight: 600,
        underline: false,
        color: '#1F1A17',
        letterSpacing: -0.01,
        lineHeight: 1.2,
        spacingScale: 1.2,
        numbering: 'none',
        // 20 / 13 / 11 pt over 10 pt text.
        levels: { h1: { size: 2 }, h2: { size: 1.3 }, h3: { size: 1.1 } }
      },
      color: { brand: '#9C3E22', secondary: '#8C8279' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '{title}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 8.5, font: 'IBM Plex Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Muted, each a distinct grey in black-and-white print; caution is the accent.
      alerts: {
        note: '#2F5A73',
        tip: '#3F6B45',
        important: '#5E4778',
        warning: '#8A6417',
        caution: '#9C3E22'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'banner', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 500, showLogo: false, align: 'left', titleSize: 3.4, subtitleSize: 1.3 },
      customCss: PROPOSAL_TEMPLATE_CSS
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
  // — Academic essay: the APA 7 student paper (Publication Manual,
  // 7th ed.) — US Letter with 1in margins, Times (TeX Gyre Termes) 12 pt
  // double-spaced throughout, ragged right without hyphenation, every
  // paragraph indented 0.5in; a title page (bold title, then author,
  // affiliation, course, instructor and date, all centred) with the page
  // number top right on every page; Level 1 headings centred bold,
  // Level 2 flush-left bold, Level 3 bold italic, all at text size; block
  // quotations indented 0.5in without quotation marks; References on a
  // new page with 0.5in hanging indents. The rest is template CSS
  // (ESSAY_TEMPLATE_CSS). Fixture: tests/fixtures/theme-shots/essay.md.
  {
    id: 'essay',
    category: 'writing',
    theme: {
      // §2.22: 1in margins on all sides.
      page: { size: 'Letter', orientation: 'portrait', margin: 25.4 },
      meta: { font: 'TeX Gyre Termes' },
      // §2.19 12 pt Times; §2.21 double spacing; §2.23 flush left, ragged right, no hyphenation; §2.24 indent (0.5in in the template CSS), no space between paragraphs.
      body: { font: 'TeX Gyre Termes', size: 12, lineHeight: 2, textAlign: 'left', color: '#000000', background: '#FFFFFF', dropCap: false, firstLineIndent: true, paragraphSpacing: 0, hyphenate: false },
      headings: {
        font: 'TeX Gyre Termes',
        scale: 1.2,
        weight: 700,
        underline: false,
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.6,
        spacingScale: 0.5,
        numbering: 'none',
        // §2.27: every level at text size and bold; Level 1 centred, Level 3 bold italic.
        levels: { h1: { size: 1, align: 'center' }, h2: { size: 1 }, h3: { size: 1, style: 'italic' }, h4: { size: 1 } }
      },
      color: { brand: '#000000', secondary: '#000000' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      // §2.18: student papers carry only the page number, top right; no running head.
      header: { left: '', center: '', right: '{page}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 10, font: 'Latin Modern Mono', background: 'none', frame: 'none', wrap: true, lineNumbers: false },
      // APA tables and figures (ch. 7): horizontal rules only, the numbered label above.
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: true },
      // §8.27 block quotations (no rule, no italics — template CSS); §9.43 hanging references.
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'rule', hrThickness: 1, figureLabel: true, referenceStyle: 'hanging' },
      mermaid: { theme: 'document' },
      // Ink-on-paper: APA papers have no admonitions; keep them dark and muted.
      alerts: {
        note: '#1f3a6e',
        tip: '#175c2e',
        important: '#5d3d99',
        warning: '#7a5200',
        caution: '#9b1a25'
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      // §2.3: bold title at text size, author / affiliation / course / instructor / date in regular weight, centred; the template CSS turns the block into a title page.
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 700, showLogo: false, align: 'center', titleSize: 1, subtitleSize: 1 },
      customCss: ESSAY_TEMPLATE_CSS
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
  },
  // — On-call runbook: an operations handbook read under stress — on a
  // second screen at 3 a.m. or as a printout pinned next to the desk.
  // Scannable before elegant: IBM Plex Sans 10/13.5 (unambiguous Il1, a
  // robust sans for small print), JetBrains Mono commands (slashed 0,
  // distinct l/1), black ink only plus strong alert colours, A4 with 15 mm
  // margins for density. Numbered sections and `{section}` in the running
  // head so "see 3.2" works; procedure steps numbered white on black;
  // checklists with real boxes; black-header zebra tables; framed alerts
  // with a label chip that survives greyscale. Template CSS:
  // RUNBOOK_TEMPLATE_CSS. Fixture: tests/fixtures/theme-shots/runbook.md.
  {
    id: 'runbook',
    category: 'engineering',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 15, marginTop: 16, marginBottom: 15 },
      meta: { font: 'IBM Plex Sans' },
      body: { font: 'IBM Plex Sans', size: 10, lineHeight: 1.35, textAlign: 'left', color: '#111111', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.45, hyphenate: false },
      headings: {
        font: 'IBM Plex Sans',
        scale: 1.2,
        weight: 700,
        underline: false,
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.2,
        spacingScale: 0.6,
        numbering: 'decimal',
        // 15.5 / 12 / 10.5 pt over 10 pt text: findable, not loud.
        levels: { h1: { size: 1.55 }, h2: { size: 1.2 }, h3: { size: 1.05 } }
      },
      color: { brand: '#000000', secondary: '#5C636B' },
      brand: { logoUrl: '', logoHeight: 40 },
      layout: { columns: 1, columnGap: 8 },
      // Which runbook, and which section the page is in (for "see 3.2").
      header: { left: '{title}', center: '', right: '{section}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true },
      // Printouts go stale: the date is on every page.
      footer: { left: '{date}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 8.5, font: 'JetBrains Mono', background: 'tint', frame: 'rule', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 3, captionPosition: 'above', captionLabel: false },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain' },
      mermaid: { theme: 'document' },
      // Signal colours dark enough to read as text and as distinct greys.
      alerts: {
        note: '#1F4E8C',
        tip: '#1D6B3A',
        important: '#5B2D91',
        warning: '#8A4B00',
        caution: '#B0101E'
      },
      toc: { maxDepth: 2, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'title-block', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, titleWeight: 700, showLogo: false, align: 'left', titleSize: 1.9, subtitleSize: 1.1 },
      customCss: RUNBOOK_TEMPLATE_CSS
    }
  }
]
