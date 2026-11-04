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
      headings: { font: 'Fraunces', scale: 1.333, weight: 500, underline: false, color: '#1F1B14', letterSpacing: -0.01, lineHeight: 1.25, spacingScale: 1.2 },
      color: { brand: '#B5371F', secondary: '#A39A8A' },
      brand: { logoUrl: '/markoto-logos/primary-lockup-light.svg', logoHeight: 56 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '{page} · {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-light', fontSize: 9 },
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
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], showLogo: true, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
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
      headings: { font: 'Inter', scale: 1.25, weight: 600, underline: false, color: '#111827', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1 },
      color: { brand: '#3B82F6', secondary: '#9ca3af' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '{page} / {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-dark', fontSize: 9 },
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
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Academic Paper: serif body, generous margins, dark-blue accent,
  // running head with title + page (no footer). Tables are minimal-
  // border (top/bottom rules only) — the academic convention.
  {
    id: 'academic',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 22 },
      meta: { font: 'Source Serif 4' },
      body: { font: 'Source Serif 4', size: 10, lineHeight: 1.4, textAlign: 'justify', color: '#0f172a', background: '#FFFFFF', dropCap: false, firstLineIndent: true, paragraphSpacing: 0.4, hyphenate: true },
      headings: { font: 'Source Serif 4', scale: 1.2, weight: 600, underline: false, color: '#0f172a', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1 },
      color: { brand: '#1e3a8a', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 2, columnGap: 7 },
      header: { left: '{title}', center: '', right: '{page}', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-light', fontSize: 10 },
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
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: true, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
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
      headings: { font: 'IBM Plex Sans', scale: 1.333, weight: 600, underline: true, color: '#0f172a', letterSpacing: 0, lineHeight: 1.2, spacingScale: 0.9 },
      color: { brand: '#0891b2', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '{page} / {pages}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-dark', fontSize: 9 },
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
      cover: { enabled: false, layout: 'editorial', showTitle: true, showSubtitle: false, subtitle: '', showDate: true, showAuthors: false, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
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
      headings: { font: 'Playfair Display', scale: 1.333, weight: 700, underline: true, color: '#b45309', letterSpacing: 0, lineHeight: 1.15, spacingScale: 1.1 },
      color: { brand: '#b45309', secondary: '#a8a29e' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '{title}', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '{date}', center: '', right: '{page} / {pages}', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-light', fontSize: 9 },
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
      cover: { enabled: true, layout: 'editorial', showTitle: true, showSubtitle: true, subtitle: '', showDate: true, showAuthors: true, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
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
      headings: { font: 'Crimson Text', scale: 1.2, weight: 600, underline: false, color: '#1c1917', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1.4 },
      color: { brand: '#4c1d95', secondary: '#a8a29e' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'none', fontSize: 10 },
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
      cover: { enabled: true, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: true, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
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
      headings: { font: 'PT Serif', scale: 1.25, weight: 700, underline: false, color: '#047857', letterSpacing: 0, lineHeight: 1.2, spacingScale: 1 },
      color: { brand: '#047857', secondary: '#a1a1aa' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '{title}', center: '', right: '{date}', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '{page}', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-light', fontSize: 8 },
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
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: false, authors: [], showLogo: false, align: 'center', titleSize: 2.4, subtitleSize: 1.15 }
    }
  },

  // — Resume: one dense page. Inter at 10pt, a flat heading scale (the
  // other presets' h2 is ~2.5× the body, which eats a third of a CV),
  // tight heading spacing, no running header, footer or cover, slate
  // accent. Made for the `resume` template (one A4 page).
  {
    id: 'resume',
    theme: {
      page: { size: 'A4', orientation: 'portrait', margin: 16 },
      meta: { font: 'Inter' },
      body: { font: 'Inter', size: 10, lineHeight: 1.4, textAlign: 'left', color: '#1f2933', background: '#FFFFFF', dropCap: false, firstLineIndent: false, paragraphSpacing: 0.45, hyphenate: false },
      headings: { font: 'Inter', scale: 1.12, weight: 600, underline: true, color: '#1e3a52', letterSpacing: 0, lineHeight: 1.2, spacingScale: 0.6 },
      color: { brand: '#2f5b7c', secondary: '#94a3b8' },
      brand: { logoUrl: '', logoHeight: 48 },
      layout: { columns: 1, columnGap: 8 },
      header: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'left', imageHeight: 12 },
      footer: { left: '', center: '', right: '', imageUrl: '', imagePosition: 'center', imageHeight: 10 },
      code: { theme: 'github-light', fontSize: 8.5 },
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
      cover: { enabled: false, layout: 'classic', showTitle: true, showSubtitle: false, subtitle: '', showDate: false, showAuthors: false, authors: [], showLogo: false, align: 'left', titleSize: 2.4, subtitleSize: 1.15 }
    }
  }
]
