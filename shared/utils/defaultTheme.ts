import type { DocTheme } from '../types/theme'

/**
 * Default theme — used as the initial value for newly-created documents
 * and as the fallback when a doc's stored theme fails validation.
 *
 * This IS the markoto preset (kept in sync with `themePresets.ts`):
 * Fraunces editorial headings on Inter body, sumi-50 cream paper, shu
 * vermillion brand, minimal table borders, neutral mermaid. Every new
 * doc opens looking like markoto by default; users pick a different
 * preset only when they want something else.
 */
export const defaultTheme: DocTheme = {
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: 24
  },
  meta: {
    // JetBrains Mono — the "instrument" voice. Used for header/footer
    // text, figcaptions, footnotes. Distinguishes meta from body
    // (Inter) and from headlines (Fraunces).
    font: 'JetBrains Mono'
  },
  body: {
    font: 'Inter',
    size: 10.5,
    // 1.55 — proportionally generous compared to print norms (LO/Word
    // sit ~1.15-1.2). Inter at 10.5pt with Fraunces headings reads as
    // "calm field guide" rather than dense report; the extra leading
    // is what carries that voice.
    lineHeight: 1.55,
    textAlign: 'left',
    color: '#14110D',         // sumi-950
    background: '#FAF8F4',    // sumi-50 — warm cream paper, not pure white
    dropCap: true,            // editorial signature on first paragraph
    firstLineIndent: false,   // markoto uses paragraph spacing, not indent
    paragraphSpacing: 0.6,    // standard print breathing
    hyphenate: false          // left-rag prose; hyphens read clinical
  },
  headings: {
    font: 'Fraunces',
    // major-third (1.333) — visible jumps without screaming
    scale: 1.333,
    weight: 500,              // brand cap — never 600+
    underline: false,
    color: '#1F1B14',         // sumi-900
    letterSpacing: -0.01,     // Fraunces wants slight negative tracking
    lineHeight: 1.25,         // generous breathing for big serif headings
    spacingScale: 1.2         // editorial top-margin breathing
  },
  color: {
    brand: '#B5371F',         // shu-500 — the seal lives here
    secondary: '#A39A8A'      // sumi-400 — warm muted brown-grey for hairlines
  },
  brand: {
    logoUrl: '',              // empty until user uploads via theme editor
    logoHeight: 48
  },
  layout: {
    columns: 1,
    columnGap: 8
  },
  header: {
    left: '',
    center: '',
    right: ''
  },
  footer: {
    left: '',
    center: '{page} · {pages}',
    right: ''
  },
  code: {
    theme: 'github-light',
    fontSize: 9
  },
  tables: {
    headerBackground: 'none',
    headerTextColor: 'inherit',
    borders: 'minimal',
    zebra: false,
    cellPadding: 8
  },
  blocks: {
    imageRadius: 0,           // sharp print corners, not iOS
    imageMaxWidth: 92,
    blockquoteStyle: 'border',
    hrStyle: 'asterism',      // editorial signature — Penguin Classics scene break
    hrThickness: 1            // unused for asterism, kept for schema completeness
  },
  mermaid: {
    theme: 'neutral'
  },
  alerts: {
    // Desaturated warm-paper palette — mirrors the markoto preset.
    note: '#3D5A80',
    tip: '#4A6F4D',
    important: '#6B4F7F',
    warning: '#9C7A2C',
    caution: '#B5371F'
  },
  toc: {
    maxDepth: 3,
    showTitle: true,
    showPageNumbers: true,
    leaderStyle: 'dotted'
  },
  cover: {
    enabled: true,            // markoto opens with a title sheet
    layout: 'centered',
    showTitle: true,
    showSubtitle: false,
    subtitle: '',
    showDate: true,
    showAuthors: false,       // user fills in via theme editor when ready
    authors: [],
    showLogo: false           // reserved for Step 10
  }
}
