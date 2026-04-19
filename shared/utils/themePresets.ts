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
  id: string                // matches i18n key under theme.presets.<id>
  theme: DocTheme
}

export const THEME_PRESETS: ThemePreset[] = [
  // — Modern: the in-app default. Inter sans, blue accent, justified
  // body, page numbers in footer. The neutral starting point.
  {
    id: 'modern',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      body: { font: 'Inter', size: 11, lineHeight: 1.3, textAlign: 'justify', color: '#111827', background: '#FFFFFF' },
      headings: { font: 'Inter', scale: 1.25, weight: 600, underline: false, color: '#111827' },
      color: { brand: '#3B82F6' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '' },
      footer: { left: '', center: '{page} / {pages}', right: '' },
      code: { theme: 'github-dark', fontSize: 9 },
      tables: { headerBackground: 'muted', headerTextColor: 'inherit', borders: 'all', zebra: false, cellPadding: 6 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'border' }
    }
  },

  // — Academic Paper: serif body, generous margins, dark-blue accent,
  // running head with title + page (no footer). Tables are minimal-
  // border (top/bottom rules only) — the academic convention.
  {
    id: 'academic',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      body: { font: 'Source Serif 4', size: 12, lineHeight: 1.5, textAlign: 'justify', color: '#0f172a', background: '#FFFFFF' },
      headings: { font: 'Source Serif 4', scale: 1.2, weight: 600, underline: false, color: '#0f172a' },
      color: { brand: '#1e3a8a' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{page}' },
      footer: { left: '', center: '', right: '' },
      code: { theme: 'github-light', fontSize: 10 },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8 },
      blocks: { imageRadius: 0, imageMaxWidth: 90, blockquoteStyle: 'border' }
    }
  },

  // — Tech Report: tight IBM Plex Sans, cyan accent, dark code,
  // underlined headings, brand-color table headers with white text +
  // zebra rows.
  {
    id: 'tech',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 20 },
      body: { font: 'IBM Plex Sans', size: 10, lineHeight: 1.4, textAlign: 'left', color: '#0f172a', background: '#FFFFFF' },
      headings: { font: 'IBM Plex Sans', scale: 1.333, weight: 600, underline: true, color: '#0f172a' },
      color: { brand: '#0891b2' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}' },
      footer: { left: '', center: '{page} / {pages}', right: '' },
      code: { theme: 'github-dark', fontSize: 9 },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 6 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'background' }
    }
  },

  // — Business Report: serif headings (Playfair) over sans body
  // (Source Sans), warm amber accent (also tinting headings), centered
  // title in head, brand-color full-bordered tables with zebra rows.
  {
    id: 'business',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      body: { font: 'Source Sans 3', size: 11, lineHeight: 1.45, textAlign: 'justify', color: '#1c1917', background: '#FFFFFF' },
      headings: { font: 'Playfair Display', scale: 1.333, weight: 700, underline: true, color: '#b45309' },
      color: { brand: '#b45309' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '{title}', right: '' },
      footer: { left: '{date}', center: '', right: '{page} / {pages}' },
      code: { theme: 'github-light', fontSize: 9 },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'all', zebra: true, cellPadding: 8 },
      blocks: { imageRadius: 6, imageMaxWidth: 95, blockquoteStyle: 'background' }
    }
  },

  // — Novel: classic Crimson Text serif, deep violet accent, generous
  // line-height, only a centered page number in the footer. Tables and
  // code blocks rare in fiction — kept minimal.
  {
    id: 'novel',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 25 },
      body: { font: 'Crimson Text', size: 12, lineHeight: 1.5, textAlign: 'justify', color: '#1c1917', background: '#FFFFFF' },
      headings: { font: 'Crimson Text', scale: 1.2, weight: 600, underline: false, color: '#1c1917' },
      color: { brand: '#4c1d95' },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '' },
      footer: { left: '', center: '{page}', right: '' },
      code: { theme: 'none', fontSize: 10 },
      tables: { headerBackground: 'none', headerTextColor: 'inherit', borders: 'minimal', zebra: false, cellPadding: 8 },
      blocks: { imageRadius: 0, imageMaxWidth: 80, blockquoteStyle: 'none' }
    }
  },

  // — Newsletter: 2-column layout, smaller body for density, sans body
  // (Karla) under serif headings (PT Serif), green accent, brand-color
  // table headers + zebra. Showcases the multi-column flow.
  {
    id: 'newsletter',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 18 },
      body: { font: 'Karla', size: 9, lineHeight: 1.35, textAlign: 'justify', color: '#18181b', background: '#FFFFFF' },
      headings: { font: 'PT Serif', scale: 1.5, weight: 700, underline: false, color: '#047857' },
      color: { brand: '#047857' },
      layout: { columns: 2, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}' },
      footer: { left: '', center: '{page}', right: '' },
      code: { theme: 'github-light', fontSize: 8 },
      tables: { headerBackground: 'brand', headerTextColor: 'auto', borders: 'horizontal', zebra: true, cellPadding: 4 },
      blocks: { imageRadius: 4, imageMaxWidth: 100, blockquoteStyle: 'background' }
    }
  }
]
