import type { DocTheme } from '../types/theme'

// Tables: header fill, borders, zebra rows, cell padding.

export function tableBlock(theme: DocTheme): string {
  const { headerBackground, headerTextColor, borders, zebra, cellPadding } = theme.tables

  // Border CSS varies by setting:
  //   all        — border on every cell (the default GFM look)
  //   horizontal — only between rows (newspaper / report style)
  //   minimal    — only at table top + bottom + below header
  //   none       — no borders at all
  let borderRules = ''
  switch (borders) {
    case 'all':
      borderRules = `.paged-doc th, .paged-doc td { border: 1px solid var(--doc-text); }`
      break
    case 'horizontal':
      borderRules = `.paged-doc tr { border-bottom: 1px solid var(--doc-secondary); }
.paged-doc tbody tr:last-child { border-bottom: none; }`
      break
    case 'minimal':
      borderRules = `.paged-doc table { border-top: 2px solid var(--doc-text); border-bottom: 2px solid var(--doc-text); }
.paged-doc thead { border-bottom: 1px solid var(--doc-text); }`
      break
    case 'none':
      // initial `let borderRules = ''` already covers this branch
      break
  }

  // Header background:
  //   brand  — full brand color (caller picks header text color)
  //   muted  — subtle tint of body text color
  //   none   — transparent (no fill)
  let headerBg = ''
  switch (headerBackground) {
    case 'brand':
      headerBg = `background: var(--doc-brand);`
      break
    case 'muted':
      headerBg = `background: color-mix(in srgb, var(--doc-text) 6%, transparent);`
      break
    case 'none':
      // initial `let headerBg = ''` already covers this branch
      break
  }

  // Header text color:
  //   auto   — pick contrasting text against the bg (white on brand,
  //            inherit on muted/none)
  //   inherit — body color regardless
  let headerColor = ''
  if (headerTextColor === 'auto' && headerBackground === 'brand') {
    headerColor = 'color: white;'
  }

  const zebraRule = zebra
    ? `.paged-doc tbody tr:nth-child(even) { background: color-mix(in srgb, var(--doc-text) 4%, transparent); }`
    : ''

  return [
    `.paged-doc table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}`,
    `.paged-doc th, .paged-doc td {
  padding: ${cellPadding}px ${Math.round(cellPadding * 1.5)}px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: break-word;
  hyphens: auto;
}`,
    // Wide tables fit the text width instead of running off the page: words
    // hyphenate, code in a cell (long identifiers, package names) may break
    // anywhere — that keeps a column's minimum width small without cutting
    // ordinary words apart — and tables with many columns get a smaller
    // type size (one selector each — paged.js splits selector lists).
    `.paged-doc td code { overflow-wrap: anywhere; }`,
    // A number and its unit, a currency and its amount, and short codes
    // like SEV-1 never part (renderMarkdown wraps them in table cells).
    `.paged-doc .markoto-nowrap { white-space: nowrap; }`,
    `.paged-doc th code { overflow-wrap: anywhere; }`,
    // How wide a table is with nothing broken apart: the pagination
    // handler sets this attribute for one measurement in a multi-column
    // page and lets a table that needs more than a column span the page.
    `.paged-doc table[data-markoto-measure] td, .paged-doc table[data-markoto-measure] th, .paged-doc table[data-markoto-measure] code, .paged-doc table[data-markoto-measure] .markoto-code-token { overflow-wrap: normal !important; word-break: normal !important; max-width: none !important; }`,
    `.paged-doc table:has(tr > :nth-child(8)) { font-size: 0.88em; }`,
    `.paged-doc table:has(tr > :nth-child(10)) { font-size: 0.8em; }`,
    `.paged-doc th {
  font-weight: 600;
  ${headerBg}
  ${headerColor}
}`,
    borderRules,
    zebraRule
  ].filter(Boolean).join('\n')
}
