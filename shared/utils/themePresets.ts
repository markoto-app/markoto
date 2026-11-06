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

export interface ThemePreset {
  id: string // matches i18n key under theme.presets.<id>
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
/* figure: \\abovecaptionskip 7pt, "Figure N:" caption in roman. */
.paged-doc figure { counter-increment: mk-fig; margin: 12pt 0; }
.paged-doc figure img { display: block; margin: 0 auto; }
.paged-doc figcaption { font: inherit; color: inherit; margin-top: 7pt; }
.paged-doc figcaption::before { content: "Figure " counter(mk-fig) ": "; }
/* booktabs: centred at natural width, \\toprule + \\bottomrule heavier than \\midrule. */
.paged-doc table { width: auto; margin: 10pt auto; }
.paged-doc table thead th { border-top: 0.08em solid; border-bottom: 0.05em solid; font-weight: 400; }
.paged-doc table tbody tr:last-child td { border-bottom: 0.08em solid; }
.paged-doc th, .paged-doc td { padding: 1pt 6pt; }
/* lists: \\leftmargini 3pc, \\topsep 4pt, \\itemsep + \\parsep 2pt each. */
.paged-doc ul, .paged-doc ol { padding-left: 36pt; margin: 4pt 0; }
.paged-doc li { margin: 4pt 0; }
/* natbib bibliography: hanging indent. */
.paged-doc #references ~ p { padding-left: 1.2em; text-indent: -1.2em; margin: 0 0 5pt; }
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
/* \\textheight 9.25in quantised to 56 lines (672pt), top margin 0.75in less half the rounding; \\textwidth 43pc centred. */
/* (paged.js margin variables, not an @page rule: a second @page replaces the theme's @footnote.) */
.pagedjs_pages .pagedjs_page { --pagedjs-margin-top: 51pt; --pagedjs-margin-bottom: 69pt; }
/* \\@maketitle: \\Huge 24/28pt title, 0.5\\baselineskip + 0.2em above, 1em - 0.25em to the author blocks. */
.paged-doc .markoto-title-block { margin: 0 0 6pt; }
.paged-doc .markoto-title-block .markoto-cover-title { line-height: 28pt; margin: -4pt 0 18pt; }
/* \\and = \\hfill: author blocks share the width; \\IEEEauthorblockN \\sublargesize (11pt) regular, \\IEEEauthorblockA \\normalsize, 2.6ex / 2.75ex lines. */
.paged-doc .markoto-title-block .markoto-cover-authors { justify-content: space-evenly; gap: 0; margin: 0 0 40pt; }
.paged-doc .markoto-title-block .markoto-cover-author { font-weight: 400; font-size: 1.1em; line-height: 11.5pt; white-space: pre-line; }
.paged-doc .markoto-title-block .markoto-cover-affiliation { line-height: 12.5pt; }
/* Two-column \\abstract + IEEEkeywords open the first column: only title and authors span the page. */
.paged-doc .markoto-cover { column-span: none; }
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
/* \\section: centred, "I." (\\Roman) + 0.5em; \\subsection "A." (\\Alph); 1.5ex above, 0.7ex below. */
.paged-doc h1, .paged-doc h2 { margin: 6.75pt 0 3.15pt; break-after: avoid; }
.paged-doc h1 { text-align: center; }
.paged-doc h1:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h1, upper-roman) "."; margin-right: 0.5em; }
.paged-doc h2:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h2, upper-alpha) "."; margin-right: 0.5em; }
/* \\subsubsection: run-in at \\parindent, "1)" and ":" after the heading (inline with its paragraph, so the two never part at a column break). */
.paged-doc h3 { display: inline; margin: 0 0.35em 0 1em; }
.paged-doc h3:not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)::before { content: counter(mk-h3) ")"; margin-right: 0.5em; }
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
/* table: \\footnotesize body, caption above: "TABLE I" (\\Roman), then the caption in small caps, centred. */
.paged-doc p.table-caption { counter-increment: mk-tab; text-align: center; text-indent: 0; font-size: 8pt; line-height: 9pt; font-variant-caps: small-caps; text-align-last: center; margin: 12pt 0 9.5pt; }
.paged-doc p.table-caption::before { content: "TABLE " counter(mk-tab, upper-roman); display: block; font-variant-caps: normal; }
.paged-doc table { width: auto; margin: 0 auto 12pt; font-size: 8pt; line-height: 9pt; border-top: 0.4pt solid; border-bottom: 0.4pt solid; }
.paged-doc th, .paged-doc td { padding: 0 6pt; font-weight: 400; }
/* \\hline: 0.4pt above the table (on the table rule), below the header and at the end. */
.paged-doc thead { border-bottom: 0.4pt solid; }
/* figure: centred, "Fig. 1." + two spaces, \\footnotesize caption below, centred when it fits one line, else justified. */
.paged-doc figure { counter-increment: mk-fig; margin: 12pt 0; text-align: center; }
.paged-doc figure img { display: block; margin: 0 auto; }
.paged-doc figcaption { font: inherit; font-size: 8pt; line-height: 9pt; font-style: normal; color: inherit; margin-top: 9pt; text-align: justify; text-align-last: center; }
.paged-doc figcaption::before { content: "Fig. " counter(mk-fig) ".\\a0\\a0"; }
/* thebibliography: \\footnotesize, "[1]" labels in a hanging list. The list after "References"; mark it {.references} so a part continued on the next page keeps the look. */
.paged-doc #references ~ ol, .paged-doc ol.references { padding-left: 1.75em; font-size: 8pt; line-height: 9pt; }
.paged-doc #references ~ ol > li::marker, .paged-doc ol.references > li::marker { content: "[" counter(list-item) "]\\2002"; }
/* \\texttt: typewriter, no box. hyperref is not loaded: links print as text. */
.paged-doc :not(pre) > code { background: none; padding: 0; border: 0; font-size: 1em; }
.paged-doc a { text-decoration: none; color: inherit; }
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
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8 },
      blocks: { imageRadius: 0, imageMaxWidth: 92, blockquoteStyle: 'border', hrStyle: 'asterism', hrThickness: 1 },
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
      tables: { headerBackground: 'muted', headerTextColor: 'inherit', borders: 'all', zebra: false, cellPadding: 6 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1 },
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
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8 },
      blocks: { imageRadius: 0, imageMaxWidth: 90, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1 },
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
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 4 },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'rule', hrThickness: 1 },
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
    theme: {
      // \textwidth 43pc on Letter → 48pt (16.93mm) side margins; top and
      // bottom come from the template CSS (51pt / 69pt).
      page: { size: 'Letter', orientation: 'portrait', margin: 16.93 },
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
        numbering: 'decimal',
        // \section \normalsize\scshape, \subsection + \subsubsection \normalsize\itshape.
        levels: { h1: { size: 1, smallCaps: true }, h2: { size: 1, style: 'italic' }, h3: { size: 1, style: 'italic' }, h4: { size: 1, style: 'italic' } }
      },
      color: { brand: '#000000', secondary: '#000000' },
      brand: { logoUrl: '', logoHeight: 48 },
      // \columnsep 1pc = 4.23mm.
      layout: { columns: 2, columnGap: 4.23 },
      // Conference mode: no running head, no page numbers (the publisher adds them).
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'none', fontSize: 8, font: 'Latin Modern Mono', background: 'none', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 2 },
      blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'none', hrStyle: 'rule', hrThickness: 1 },
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

  // — Tech Report: tight IBM Plex Sans, cyan accent, dark code,
  // underlined headings, brand-color table headers with white text +
  // zebra rows.
  {
    id: 'tech',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      meta: { font: 'IBM Plex Mono' },
      body: { font: 'IBM Plex Sans', size: 10, lineHeight: 1.4, textAlign: 'left', color: '#0f172a', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.7, hyphenate: false },
      headings: { font: 'IBM Plex Sans', scale: 1.25, weight: 600, underline: true, color: '#0f172a', letterSpacing: 0, lineHeight: 1.2, spacingScale: 0.9, numbering: 'decimal', levels: {} },
      color: { brand: '#0891b2', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '', center: '{page} / {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-dark', fontSize: 8.5, font: 'IBM Plex Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 6 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'background', hrStyle: 'rule', hrThickness: 2 },
      mermaid: { theme: 'document' },
      // Tech-report cyan-ish palette — note picks up the brand colour
      // since cyan IS the report's voice. The rest stay traditional.
      alerts: {
        note: '#0891b2',
        tip: '#1a7f37',
        important: '#7c3aed',
        warning: '#b45309',
        caution: '#dc2626'
      },
      toc: { maxDepth: 4, showTitle: true, showPageNumbers: true, leaderStyle: 'dashed' },
      cover: { enabled: false, layout: 'editorial', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Business Report: serif headings (Playfair) over sans body
  // (Source Sans), warm amber accent (also tinting headings), centered
  // title in head, brand-color full-bordered tables with zebra rows.
  {
    id: 'business',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      meta: { font: 'Source Sans 3' },
      body: { font: 'Source Sans 3', size: 11, lineHeight: 1.45, textAlign: 'justify', color: '#1c1917', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.8, hyphenate: true },
      headings: { font: 'Playfair Display', scale: 1.25, weight: 700, underline: true, color: '#b45309', letterSpacing: 0, lineHeight: 1.15, spacingScale: 1.1, numbering: 'none', levels: {} },
      color: { brand: '#b45309', secondary: '#a8a29e' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '{title}', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false },
      footer: { left: '{date}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
      code: { theme: 'github-light', fontSize: 9, font: 'IBM Plex Mono', background: 'auto', frame: 'rule', wrap: true, lineNumbers: false },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'all', zebra: true, cellPadding: 8 },
      blocks: { imageRadius: 6, imageMaxWidth: 95, blockquoteStyle: 'background', hrStyle: 'rule', hrThickness: 1 },
      mermaid: { theme: 'document' },
      // Business-report warm palette — note shifts to a navy that
      // pairs with the amber brand; warning picks up the brand amber.
      alerts: {
        note: '#1e3a8a',
        tip: '#15803d',
        important: '#7e22ce',
        warning: '#b45309',
        caution: '#991b1b'
      },
      toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], affiliations: [], rules: false, smallCaps: false, showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Novel: classic Crimson Text serif, deep violet accent, generous
  // line-height, only a centered page number in the footer. Tables and
  // code blocks rare in fiction — kept minimal.
  {
    id: 'novel',
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
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8 },
      blocks: { imageRadius: 0, imageMaxWidth: 80, blockquoteStyle: 'none', hrStyle: 'asterism', hrThickness: 1 },
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
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 4 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'background', hrStyle: 'dashed', hrThickness: 1 },
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
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 3 },
      blocks: { imageRadius: 2, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1 },
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
