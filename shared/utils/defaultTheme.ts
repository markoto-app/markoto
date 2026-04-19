import type { DocTheme } from '../types/theme'

/**
 * Default theme — used as the initial value for newly-created documents
 * and as the fallback when a doc's stored theme fails validation.
 */
export const defaultTheme: DocTheme = {
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: 20
  },
  body: {
    font: 'Inter',
    size: 11,
    // 1.3 lines up with print-typography norms (LibreOffice/Word
    // "single" sits around 1.15–1.2; 1.3 nudges a little roomier
    // because Inter's x-height is taller than Times/Calibri).
    lineHeight: 1.3,
    textAlign: 'justify',
    color: '#111827',
    background: '#FFFFFF'
  },
  headings: {
    font: 'Inter',
    scale: 1.25,
    weight: 600,
    underline: false,
    color: '#111827'
  },
  color: {
    brand: '#3B82F6'
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
  code: {
    theme: 'github-dark',
    fontSize: 9
  },
  tables: {
    headerBackground: 'muted',
    headerTextColor: 'inherit',
    borders: 'all',
    zebra: false,
    cellPadding: 6
  },
  blocks: {
    imageRadius: 4,
    imageMaxWidth: 100,
    blockquoteStyle: 'border'
  }
}
