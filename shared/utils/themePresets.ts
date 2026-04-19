import type { DocTheme } from '../types/theme'

/**
 * Built-in theme templates. Each preset is a complete DocTheme that
 * fully replaces the user's current settings when selected — no merge,
 * no partial overrides. Names and descriptions live in i18n under
 * `theme.presets.<id>.name` / `theme.presets.<id>.description`, which
 * keeps localization out of this file and lets the UI strings change
 * without touching the design data.
 *
 * Add a preset by appending to THEME_PRESETS and adding the matching
 * i18n keys (en + every other locale). The `id` is the i18n suffix,
 * keep it lowercase ASCII, no spaces.
 */

export interface ThemePreset {
  id: string                // matches i18n key under theme.presets.<id>
  theme: DocTheme
}

export const THEME_PRESETS: ThemePreset[] = [
  // — Modern: the in-app default. Clean Inter sans, blue brand,
  // justified body, page numbers in footer. The neutral starting point.
  {
    id: 'modern',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      typography: {
        bodyFont: 'Inter',
        bodySize: 11,
        lineHeight: 1.3,
        headingFont: 'Inter',
        headingScale: 1.25,
        headingUnderline: false,
        textAlign: 'justify'
      },
      color: { brand: '#3B82F6', text: '#111827', background: '#FFFFFF' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '' },
      footer: { left: '', center: '{page} / {pages}', right: '' },
      blocks: { imageRadius: 4, imageMaxWidth: 100, codeBlockTheme: 'light', blockquoteStyle: 'border' }
    }
  },

  // — Academic: serif body (Source Serif 4), wider margins, larger
  // type, conservative dark-blue accent. Title left + page-number
  // right in the running head, no footer — typical journal layout.
  {
    id: 'academic',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      typography: {
        bodyFont: 'Source Serif 4',
        bodySize: 12,
        lineHeight: 1.5,
        headingFont: 'Source Serif 4',
        headingScale: 1.2,
        headingUnderline: false,
        textAlign: 'justify'
      },
      color: { brand: '#1e3a8a', text: '#0f172a', background: '#FFFFFF' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{page}' },
      footer: { left: '', center: '', right: '' },
      blocks: { imageRadius: 0, imageMaxWidth: 90, codeBlockTheme: 'light', blockquoteStyle: 'border' }
    }
  },

  // — Tech Report: sleek sans (IBM Plex Sans), tighter type, dark
  // code blocks, cyan accent, underlined headings to match technical-
  // documentation conventions. Date in the head, page numbers in the
  // foot.
  {
    id: 'tech',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      typography: {
        bodyFont: 'IBM Plex Sans',
        bodySize: 10,
        lineHeight: 1.4,
        headingFont: 'IBM Plex Sans',
        headingScale: 1.333,
        headingUnderline: true,
        textAlign: 'left'
      },
      color: { brand: '#0891b2', text: '#0f172a', background: '#FFFFFF' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}' },
      footer: { left: '', center: '{page} / {pages}', right: '' },
      blocks: { imageRadius: 4, imageMaxWidth: 100, codeBlockTheme: 'dark', blockquoteStyle: 'background' }
    }
  },

  // — Business Report: serif headings (Playfair) over sans body
  // (Source Sans), warm amber accent, larger margins, centered title
  // in the header. Date + page bracket the footer.
  {
    id: 'business',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      typography: {
        bodyFont: 'Source Sans 3',
        bodySize: 11,
        lineHeight: 1.45,
        headingFont: 'Playfair Display',
        headingScale: 1.333,
        headingUnderline: true,
        textAlign: 'justify'
      },
      color: { brand: '#b45309', text: '#1c1917', background: '#FFFFFF' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '{title}', right: '' },
      footer: { left: '{date}', center: '', right: '{page} / {pages}' },
      blocks: { imageRadius: 6, imageMaxWidth: 95, codeBlockTheme: 'light', blockquoteStyle: 'background' }
    }
  },

  // — Novel: classic literary serif (Crimson Text), larger type and
  // line-height for long-form reading, deep violet accent, only a
  // page number in the footer. Plain blockquotes (italic, no chrome).
  {
    id: 'novel',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      typography: {
        bodyFont: 'Crimson Text',
        bodySize: 12,
        lineHeight: 1.5,
        headingFont: 'Crimson Text',
        headingScale: 1.2,
        headingUnderline: false,
        textAlign: 'justify'
      },
      color: { brand: '#4c1d95', text: '#1c1917', background: '#FFFFFF' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '' },
      footer: { left: '', center: '{page}', right: '' },
      blocks: { imageRadius: 0, imageMaxWidth: 80, codeBlockTheme: 'none', blockquoteStyle: 'none' }
    }
  }
]
