import type { DocTheme } from '../types/theme'

/**
 * Default theme applied to every document in Phase 1. Once Phase 2 lands,
 * this becomes the seed value for the documents.theme JSONB column and the
 * fallback when a document was created before themes existed.
 */
export const defaultTheme: DocTheme = {
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: 20
  },
  typography: {
    bodyFont: 'Inter',
    bodySize: 11,
    // 1.3 lines up with print-typography norms (LibreOffice/Word
    // "single" sits around 1.15–1.2; 1.3 nudges a little roomier
    // because Inter's x-height is taller than Times/Calibri). Earlier
    // 1.55 was web-reading-loose and dropped the per-page word count
    // by ~30 % vs. equivalent point sizes in LibreOffice.
    lineHeight: 1.3,
    headingFont: 'Inter',
    headingScale: 1.25,
    headingUnderline: false,
    textAlign: 'justify'
  },
  color: {
    brand: '#3B82F6',
    text: '#111827',
    background: '#FFFFFF'
  },
  layout: {
    columns: 1,
    columnGap: 8
  },
  header: {
    left: '{title}',
    center: '',
    right: ''
  },
  footer: {
    left: '',
    center: '{page} / {pages}',
    right: ''
  },
  blocks: {
    imageRadius: 4,
    imageMaxWidth: 100,
    codeBlockTheme: 'light',
    blockquoteStyle: 'border'
  }
}
