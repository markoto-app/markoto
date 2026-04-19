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
    lineHeight: 1.55,
    headingFont: 'Inter',
    headingScale: 1.25,
    headingUnderline: false
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
