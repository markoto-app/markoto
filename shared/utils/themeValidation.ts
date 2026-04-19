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
const CODE_THEMES = new Set(['light', 'dark', 'none'])
const BLOCKQUOTE_STYLES = new Set(['border', 'background', 'none'])
const TEXT_ALIGNS = new Set(['left', 'justify'])
const TOKEN_REGEX = /\{(?:title|page|pages|date)\}/g
// Allow any chars except CSS-syntax-breaking ones in the literal portions
// of header/footer templates. Tokens are stripped before this check.
const SAFE_TEXT = /^[^"\\\n\r<>]*$/
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
// Conservative font-name pattern — Google Fonts allows letters, digits,
// spaces. No quotes or CSS metacharacters: themeToCss wraps the name in
// quotes, so a stray quote would let a payload escape the family= URL.
const FONT_NAME = /^[A-Za-z0-9 ]{1,40}$/

function isHex(s: unknown): s is string {
  return typeof s === 'string' && HEX_COLOR.test(s)
}

function isFontName(s: unknown): s is string {
  return typeof s === 'string' && FONT_NAME.test(s)
}

function isNumberInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

function isSlotTemplate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s.length > 200) return false
  // Strip allowed tokens, then validate what remains is plain text.
  return SAFE_TEXT.test(s.replace(TOKEN_REGEX, ''))
}

export function isValidTheme(t: unknown): t is DocTheme {
  if (!t || typeof t !== 'object') return false
  const theme = t as Record<string, any>

  if (!theme.page || typeof theme.page !== 'object') return false
  if (!PAGE_SIZES.has(theme.page.size)) return false
  if (!ORIENTATIONS.has(theme.page.orientation)) return false
  if (!isNumberInRange(theme.page.margin, 0, 60)) return false

  if (!theme.typography || typeof theme.typography !== 'object') return false
  const typo = theme.typography
  if (!isFontName(typo.bodyFont)) return false
  if (!isFontName(typo.headingFont)) return false
  if (!isNumberInRange(typo.bodySize, 6, 24)) return false
  if (!isNumberInRange(typo.lineHeight, 0.8, 3)) return false
  if (!isNumberInRange(typo.headingScale, 1, 2)) return false
  if (typeof typo.headingUnderline !== 'boolean') return false
  if (!TEXT_ALIGNS.has(typo.textAlign)) return false

  if (!theme.color || typeof theme.color !== 'object') return false
  if (!isHex(theme.color.brand)) return false
  if (!isHex(theme.color.text)) return false
  if (!isHex(theme.color.background)) return false

  if (!theme.layout || typeof theme.layout !== 'object') return false
  if (!COLUMN_COUNTS.has(theme.layout.columns)) return false
  if (!isNumberInRange(theme.layout.columnGap, 0, 30)) return false

  for (const slot of [theme.header, theme.footer]) {
    if (!slot || typeof slot !== 'object') return false
    if (!isSlotTemplate(slot.left)) return false
    if (!isSlotTemplate(slot.center)) return false
    if (!isSlotTemplate(slot.right)) return false
  }

  if (!theme.blocks || typeof theme.blocks !== 'object') return false
  if (!isNumberInRange(theme.blocks.imageRadius, 0, 32)) return false
  if (!isNumberInRange(theme.blocks.imageMaxWidth, 10, 100)) return false
  if (!CODE_THEMES.has(theme.blocks.codeBlockTheme)) return false
  if (!BLOCKQUOTE_STYLES.has(theme.blocks.blockquoteStyle)) return false

  return true
}
