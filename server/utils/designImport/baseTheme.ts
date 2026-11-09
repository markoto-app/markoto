import type { DocTheme } from '~~/shared/types/theme'

/**
 * Starting point of every design made from a document. Deliberately plain
 * (no cover, no running text, no drop cap, no logo, no custom CSS) so the
 * model's patch carries the look and nothing of a markoto preset leaks
 * into a company's design. Every field is spelled out; new optional theme
 * fields stay absent here (absent = the old look).
 */
export const DESIGN_IMPORT_BASE_THEME: DocTheme = {
  page: { size: 'A4', orientation: 'portrait', margin: 25, mirrorMargins: false },
  meta: { font: 'Inter' },
  body: {
    font: 'Inter',
    size: 10.5,
    lineHeight: 1.45,
    textAlign: 'left',
    color: '#1A1A1A',
    background: '#FFFFFF',
    dropCap: false,
    firstLineIndent: false,
    paragraphSpacing: 0.6,
    hyphenate: false
  },
  headings: {
    font: 'Inter',
    scale: 1.25,
    weight: 600,
    underline: false,
    color: '#1A1A1A',
    letterSpacing: 0,
    lineHeight: 1.2,
    spacingScale: 1,
    numbering: 'none',
    levels: {},
    numberingDepth: 4,
    chapterLabel: false,
    chapterWord: ''
  },
  color: { brand: '#1A1A1A', secondary: '#8A8A8A' },
  brand: { logoUrl: '', logoHeight: 48 },
  layout: { columns: 1, columnGap: 8 },
  header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: false, sectionNumber: false, sectionMode: 'first' },
  footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: false },
  code: { theme: 'github-light', fontSize: 9, font: 'JetBrains Mono', background: 'auto', frame: 'none', wrap: true, lineNumbers: false },
  tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'horizontal', zebra: false, cellPadding: 4, captionPosition: 'above', captionLabel: false },
  blocks: { imageRadius: 0, imageMaxWidth: 100, blockquoteStyle: 'border', hrStyle: 'rule', hrThickness: 1, figureLabel: false, referenceStyle: 'plain', captionNumbering: 'document', captionLabelStyle: 'inline' },
  mermaid: { theme: 'document' },
  alerts: { note: '#2F5D8A', tip: '#3B6E4F', important: '#5B4A7E', warning: '#8F661C', caution: '#9E2A2B' },
  toc: { maxDepth: 3, showTitle: true, showPageNumbers: true, leaderStyle: 'dotted' },
  cover: {
    enabled: false,
    layout: 'editorial',
    align: 'left',
    showTitle: true,
    showSubtitle: false,
    subtitle: '',
    showDate: false,
    showAuthors: false,
    authors: [],
    affiliations: [],
    rules: false,
    smallCaps: false,
    showLogo: false,
    titleSize: 2.4,
    subtitleSize: 1.3,
    dateFormat: 'locale',
    repeatTitle: false
  }
}
