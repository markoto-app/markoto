import type { DocTheme } from '../types/theme'

/**
 * Structural validator for DocTheme payloads coming from the client (PUT
 * /meta) or being applied from `ymeta.theme`. Server uses this as the
 * input boundary on the meta endpoint; client uses it before writing
 * untrusted data into the Y.Map.
 *
 * Strict on shape (every field present, type-checked) and bounded on
 * numeric ranges so a malicious or buggy client can't push e.g.
 * `bodySize: 1e9` and crash paged.js. Color hex is a regex check —
 * `themeToCss` interpolates colors directly into CSS so we don't want
 * arbitrary strings (e.g. `red; } body { display: none`).
 */

const PAGE_SIZES = new Set(['A4', 'Letter', 'Legal'])
const ORIENTATIONS = new Set(['portrait', 'landscape'])
const COLUMN_COUNTS = new Set([1, 2, 3])
const TEXT_ALIGNS = new Set(['left', 'justify'])
const BLOCKQUOTE_STYLES = new Set(['border', 'background', 'none'])
const HEADING_WEIGHTS = new Set([400, 500, 600, 700, 800, 900])
const CODE_THEMES = new Set([
  'github-light', 'github-dark', 'monokai', 'dracula',
  'solarized-light', 'solarized-dark', 'none'
])
const TABLE_HEADER_BGS = new Set(['brand', 'muted', 'none'])
const TABLE_HEADER_COLORS = new Set(['auto', 'inherit'])
const TABLE_BORDERS = new Set(['all', 'horizontal', 'minimal', 'none'])
const MERMAID_THEMES = new Set(['default', 'dark', 'forest', 'neutral', 'base'])
const TOC_LEADER_STYLES = new Set(['dotted', 'dashed', 'none'])
const TOC_MAX_DEPTHS = new Set([2, 3, 4])

const TOKEN_REGEX = /\{(?:title|page|pages|date)\}/g
const SAFE_TEXT = /^[^"\\\n\r<>]*$/
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
// Conservative font-name pattern. Google Fonts allows letters, digits,
// spaces. No quotes or CSS metacharacters: themeToCss wraps the name in
// quotes, so a stray quote would let a payload escape the family= URL.
const FONT_NAME = /^[A-Za-z0-9 ]{1,40}$/

const isHex = (s: unknown): s is string => typeof s === 'string' && HEX_COLOR.test(s)
const isFontName = (s: unknown): s is string => typeof s === 'string' && FONT_NAME.test(s)
const isNumberInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

const isSlotTemplate = (s: unknown): s is string => {
  if (typeof s !== 'string') return false
  if (s.length > 200) return false
  return SAFE_TEXT.test(s.replace(TOKEN_REGEX, ''))
}

export function isValidTheme(t: unknown): t is DocTheme {
  if (!t || typeof t !== 'object') return false
  const theme = t as Record<string, any>

  // page
  if (!theme.page || typeof theme.page !== 'object') return false
  if (!PAGE_SIZES.has(theme.page.size)) return false
  if (!ORIENTATIONS.has(theme.page.orientation)) return false
  if (!isNumberInRange(theme.page.margin, 0, 60)) return false

  // body
  if (!theme.body || typeof theme.body !== 'object') return false
  if (!isFontName(theme.body.font)) return false
  if (!isNumberInRange(theme.body.size, 6, 24)) return false
  if (!isNumberInRange(theme.body.lineHeight, 0.8, 3)) return false
  if (!TEXT_ALIGNS.has(theme.body.textAlign)) return false
  if (!isHex(theme.body.color)) return false
  if (!isHex(theme.body.background)) return false

  // headings
  if (!theme.headings || typeof theme.headings !== 'object') return false
  if (!isFontName(theme.headings.font)) return false
  if (!isNumberInRange(theme.headings.scale, 1, 2)) return false
  if (!HEADING_WEIGHTS.has(theme.headings.weight)) return false
  if (typeof theme.headings.underline !== 'boolean') return false
  if (!isHex(theme.headings.color)) return false

  // color
  if (!theme.color || typeof theme.color !== 'object') return false
  if (!isHex(theme.color.brand)) return false

  // layout
  if (!theme.layout || typeof theme.layout !== 'object') return false
  if (!COLUMN_COUNTS.has(theme.layout.columns)) return false
  if (!isNumberInRange(theme.layout.columnGap, 0, 30)) return false

  // header / footer
  for (const slot of [theme.header, theme.footer]) {
    if (!slot || typeof slot !== 'object') return false
    if (!isSlotTemplate(slot.left)) return false
    if (!isSlotTemplate(slot.center)) return false
    if (!isSlotTemplate(slot.right)) return false
  }

  // code
  if (!theme.code || typeof theme.code !== 'object') return false
  if (!CODE_THEMES.has(theme.code.theme)) return false
  if (!isNumberInRange(theme.code.fontSize, 6, 16)) return false

  // tables
  if (!theme.tables || typeof theme.tables !== 'object') return false
  if (!TABLE_HEADER_BGS.has(theme.tables.headerBackground)) return false
  if (!TABLE_HEADER_COLORS.has(theme.tables.headerTextColor)) return false
  if (!TABLE_BORDERS.has(theme.tables.borders)) return false
  if (typeof theme.tables.zebra !== 'boolean') return false
  if (!isIntInRange(theme.tables.cellPadding, 0, 24)) return false

  // blocks
  if (!theme.blocks || typeof theme.blocks !== 'object') return false
  if (!isNumberInRange(theme.blocks.imageRadius, 0, 32)) return false
  if (!isNumberInRange(theme.blocks.imageMaxWidth, 10, 100)) return false
  if (!BLOCKQUOTE_STYLES.has(theme.blocks.blockquoteStyle)) return false

  // mermaid
  if (!theme.mermaid || typeof theme.mermaid !== 'object') return false
  if (!MERMAID_THEMES.has(theme.mermaid.theme)) return false

  // toc
  if (!theme.toc || typeof theme.toc !== 'object') return false
  if (!TOC_MAX_DEPTHS.has(theme.toc.maxDepth)) return false
  if (typeof theme.toc.showTitle !== 'boolean') return false
  if (typeof theme.toc.showPageNumbers !== 'boolean') return false
  if (!TOC_LEADER_STYLES.has(theme.toc.leaderStyle)) return false

  return true
}
