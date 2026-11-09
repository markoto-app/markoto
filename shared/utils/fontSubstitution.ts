import { CODE_FONT_NAMES, THEME_FONTS, type FontCategory } from './themeFonts'

/**
 * Nearest self-hosted font for a font named in an uploaded document
 * ("Create a design from a document"). Documents name fonts we don't
 * ship (Calibri, Arial, Minion Pro …) and PDFs carry PostScript names
 * (`ABCDEF+TimesNewRomanPSMT`, `LiberationSans-Bold`). We never fetch or
 * accept font files; the design gets the closest family of the curated
 * list (`THEME_FONTS`, `CODE_FONT_NAMES`) instead.
 *
 * Matching works on a compact form (lower case, letters and digits only,
 * subset prefix and PostScript style suffix removed):
 *   1. the same family is in the registry → exact;
 *   2. a known family or its metric clone → its look-alike
 *      (`LOOK_ALIKES`, longest matching prefix wins: "timesnewroman…"
 *      → Times);
 *   3. otherwise a category guess from the name (mono / serif / sans)
 *      → that category's neutral default.
 */

export interface FontSubstitution {
  /** Registry family to use. */
  name: string
  /** The document's font is in the registry itself. */
  exact: boolean
  category: FontCategory
}

/** Compact name → registry family. Keys are compact forms (see `compactFontName`). */
const LOOK_ALIKES: Record<string, string> = {
  // Times and its metric clones
  times: 'TeX Gyre Termes',
  liberationserif: 'TeX Gyre Termes',
  nimbusroman: 'TeX Gyre Termes',
  tinos: 'TeX Gyre Termes',
  termes: 'TeX Gyre Termes',
  freeserif: 'TeX Gyre Termes',
  // Helvetica / Arial and clones
  arial: 'TeX Gyre Heros',
  helvetica: 'TeX Gyre Heros',
  liberationsans: 'TeX Gyre Heros',
  nimbussans: 'TeX Gyre Heros',
  arimo: 'TeX Gyre Heros',
  freesans: 'TeX Gyre Heros',
  heros: 'TeX Gyre Heros',
  // Neo-grotesques
  helveticaneue: 'Inter',
  univers: 'Inter',
  akzidenz: 'Inter',
  neuehaas: 'Inter',
  suisse: 'Inter',
  sfpro: 'Inter',
  sanfrancisco: 'Inter',
  aptos: 'Inter',
  // Office defaults (Carlito, Calibri's metric clone, is drawn from Lato)
  calibri: 'Lato',
  carlito: 'Lato',
  cambria: 'PT Serif',
  caladea: 'PT Serif',
  candara: 'Lato',
  corbel: 'Source Sans 3',
  constantia: 'Merriweather',
  segoeui: 'Open Sans',
  segoe: 'Open Sans',
  // Humanist sans
  frutiger: 'Source Sans 3',
  myriad: 'Source Sans 3',
  sourcesans: 'Source Sans 3',
  trebuchet: 'Source Sans 3',
  verdana: 'Open Sans',
  tahoma: 'Open Sans',
  notosans: 'Open Sans',
  droidsans: 'Open Sans',
  dejavusans: 'Open Sans',
  gillsans: 'Lato',
  lucida: 'Lato',
  // Geometric sans
  futura: 'DM Sans',
  centurygothic: 'DM Sans',
  avenir: 'DM Sans',
  gotham: 'Work Sans',
  montserrat: 'Work Sans',
  poppins: 'DM Sans',
  proximanova: 'DM Sans',
  circular: 'DM Sans',
  graphik: 'Inter',
  // Serifs
  georgia: 'Merriweather',
  gelasio: 'Merriweather',
  garamond: 'EB Garamond',
  adobegaramond: 'EB Garamond',
  caslon: 'EB Garamond',
  sabon: 'EB Garamond',
  palatino: 'Crimson Text',
  bookantiqua: 'Crimson Text',
  pagella: 'Crimson Text',
  p052: 'Crimson Text',
  minion: 'Crimson Text',
  baskerville: 'Libre Baskerville',
  bodoni: 'Playfair Display',
  didot: 'Playfair Display',
  centuryschoolbook: 'PT Serif',
  newcenturyschoolbook: 'PT Serif',
  c059: 'PT Serif',
  bookman: 'PT Serif',
  notoserif: 'Source Serif 4',
  droidserif: 'Source Serif 4',
  dejavuserif: 'Source Serif 4',
  sourceserif: 'Source Serif 4',
  robotoslab: 'PT Serif',
  computermodern: 'Latin Modern Roman',
  cmr: 'Latin Modern Roman',
  lmroman: 'Latin Modern Roman',
  // Monospace (code only)
  courier: 'IBM Plex Mono',
  couriernew: 'IBM Plex Mono',
  nimbusmono: 'IBM Plex Mono',
  liberationmono: 'IBM Plex Mono',
  consolas: 'JetBrains Mono',
  menlo: 'JetBrains Mono',
  monaco: 'JetBrains Mono',
  dejavusansmono: 'JetBrains Mono',
  sourcecodepro: 'JetBrains Mono',
  firacode: 'JetBrains Mono',
  firamono: 'JetBrains Mono',
  sfmono: 'JetBrains Mono',
  lmmono: 'Latin Modern Mono'
}

const DEFAULT_BY_CATEGORY: Record<FontCategory, string> = {
  sans: 'Inter',
  serif: 'Source Serif 4',
  mono: 'JetBrains Mono'
}

const STYLE_WORDS = /(?:regular|roman|book|bold|semibold|demibold|extrabold|ultrabold|black|heavy|medium|light|extralight|ultralight|thin|italic|oblique|condensed|narrow|psmt|mt|ps|std|pro|lt)+$/

/** Lower-case letters + digits of the family part of a font name ("ABCDEF+Arial-BoldMT" → "arial"). */
export function compactFontName(raw: string): string {
  let name = raw.trim()
  name = name.replace(/^[A-Z]{6}\+/, '') // PDF subset prefix
  name = name.split(/[,-]/)[0] ?? '' // PostScript / Word style suffix ("Arial-BoldMT", "Calibri,Bold")
  let compact = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  // Style words glued on without a separator ("TimesNewRomanPSMT", "HelveticaNeueLight").
  const stripped = compact.replace(STYLE_WORDS, '')
  if (stripped.length >= 3) compact = stripped
  return compact
}

const REGISTRY: Array<{ name: string, category: FontCategory, compact: string }> = [
  ...THEME_FONTS.map(f => ({ name: f.name, category: f.category, compact: compactFontName(f.name) })),
  ...CODE_FONT_NAMES.map(name => ({ name, category: 'mono' as FontCategory, compact: compactFontName(name) }))
]

const LOOK_ALIKE_KEYS = Object.keys(LOOK_ALIKES).sort((a, b) => b.length - a.length)

function categoryOf(name: string): FontCategory {
  const entry = REGISTRY.find(f => f.name === name)
  return entry?.category ?? 'sans'
}

function guessCategory(compact: string): FontCategory {
  if (/mono|code|courier|typewriter|console/.test(compact)) return 'mono'
  if (/sans|grotesk|grotesque|gothic/.test(compact)) return 'sans'
  if (/serif|roman|times|garamond|antiqua|book|text|caslon|slab/.test(compact)) return 'serif'
  return 'sans'
}

/**
 * Nearest registry family for `raw`. `role: 'code'` keeps the answer
 * monospace (the code font); `text` (body, headings, meta) always gets a
 * family from the text pickers, so a document set in a typewriter face
 * falls back to the neutral sans.
 */
export function substituteFont(raw: string, role: 'text' | 'code' = 'text'): FontSubstitution {
  const compact = compactFontName(raw)
  const pool = REGISTRY.filter(f => (f.category === 'mono') === (role === 'code'))
  const exact = compact ? pool.find(f => f.compact === compact) : undefined
  if (exact) return { name: exact.name, exact: true, category: exact.category }

  const key = compact ? LOOK_ALIKE_KEYS.find(k => compact.startsWith(k)) : undefined
  if (key) {
    const name = LOOK_ALIKES[key] ?? DEFAULT_BY_CATEGORY.sans
    const category = categoryOf(name)
    if (role === 'code' && category !== 'mono') return { name: DEFAULT_BY_CATEGORY.mono, exact: false, category: 'mono' }
    if (role === 'text' && category === 'mono') return { name: DEFAULT_BY_CATEGORY.sans, exact: false, category: 'sans' }
    return { name, exact: false, category }
  }

  const guessed = guessCategory(compact)
  const category: FontCategory = role === 'code' ? 'mono' : guessed === 'mono' ? 'sans' : guessed
  return { name: DEFAULT_BY_CATEGORY[category], exact: false, category }
}
