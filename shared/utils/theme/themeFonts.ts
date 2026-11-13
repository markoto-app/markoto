/**
 * Fonts the app serves from its own origin (`/vendor/fonts/…`), and the
 * curated subset shown in the theme editor's font pickers.
 *
 * Every family is built at `nuxt build` / `nuxt dev` from a pinned
 * Fontsource npm package (OFL / Apache, licence copied next to the
 * files) by `modules/vendor-assets.ts`: woff2 only, one stylesheet per
 * family at `fontStylesheetUrl(name)`, split into Google's unicode-range
 * subsets so a browser only downloads the subsets (and the weights /
 * styles) a page actually uses. Nothing is fetched from Google Fonts.
 *
 * Documents use STATIC cuts (one file per weight), never variable fonts:
 * Chromium's PDF backend (Skia) embeds a variable font as Type 3 glyph
 * procedures: bigger files, no hinting, refused by some print shops,
 * and the server PDF comes from Chromium. The preview uses the same
 * files so it stays what the PDF shows. Only the app shell keeps the
 * variable cuts of its brand fonts (`uiFontStylesheetUrls`, family names
 * `'Inter Variable'` …, see `uiFontFamilyName`), e.g. for Fraunces'
 * optical sizes in display headlines.
 *
 * A theme stored in the DB can still name a family outside this list
 * (`themeValidation.isFontName` only clamps it to safe characters); it
 * then renders in the system fallback stack, since there is no file to
 * serve for it.
 */

export type FontCategory = 'sans' | 'serif' | 'mono'

export interface ThemeFont {
  name: string
  category: FontCategory
}

/** Where a family's files come from: a Fontsource package + the stylesheets in it to take @font-face rules from. */
export interface FontsourceSource {
  kind: 'fontsource'
  /** npm package (pinned exactly in package.json devDependencies). */
  package: string
  /** Stylesheets inside the package (each a list of per-subset @font-face rules). */
  stylesheets: readonly string[]
}

/** One woff2 file of a bundled family (`fonts/<slug>/<file>`). */
export interface BundledFace {
  file: string
  style: 'normal' | 'italic'
  weight: number
  /** What this file covers when it isn't the family's `unicodeRange` (a companion file for another script). */
  unicodeRange?: string
  /** Licence of this file when it isn't the family's LICENSE.txt (in the same folder). */
  licence?: string
}

/**
 * A family that isn't on Fontsource, committed to the repo as WOFF2
 * subsets in `fonts/<slug>/` (with its LICENSE.txt; how the files were
 * made: `scripts/build-bundled-fonts.py`). Served exactly like the
 * Fontsource families. Adding one: put the files in `fonts/<slug>/` and
 * list them here.
 */
export interface BundledSource {
  kind: 'bundled'
  /**
   * Version of the files, part of the immutable URL: the upstream
   * version, plus `-<n>` once our subset of it changed (browsers keep
   * the old bytes of an unchanged URL for a year).
   */
  version: string
  /** What the files cover, the @font-face `unicode-range`. */
  unicodeRange: string
  faces: readonly BundledFace[]
}

export type FontSource = FontsourceSource | BundledSource

export interface SelfHostedFont extends ThemeFont {
  /** URL-safe id; also the file name of the family's stylesheet. */
  slug: string
  /** The files documents use (static cuts, see above). */
  source: FontSource
  /** Variable cut for the app shell only (`uiFontStylesheetUrls`), served as `<slug>.variable.css`. */
  ui?: FontsourceSource
  /** Listed in the theme editor's font pickers. */
  picker: boolean
}

/** Variable font (app shell only): one file per subset and style covers every weight. */
function variable(slug: string, axis: 'wght' | 'opsz' = 'wght'): FontsourceSource {
  return { kind: 'fontsource', package: `@fontsource-variable/${slug}`, stylesheets: [`${axis}.css`, `${axis}-italic.css`] }
}

/**
 * Weights a document can ask for: body 400, bold 700, the heading
 * weights 400–900 (`HeadingWeightSchema`), definition terms 600. A
 * weight a family doesn't ship falls back to the nearest one it does.
 */
const DOCUMENT_FONT_WEIGHTS = [400, 500, 600, 700, 800, 900] as const

/** Static font: one file per subset, weight and style. */
function staticWeights(slug: string, weights: readonly number[] = DOCUMENT_FONT_WEIGHTS): FontsourceSource {
  return { kind: 'fontsource', package: `@fontsource/${slug}`, stylesheets: weights.flatMap(w => [`${w}.css`, `${w}-italic.css`]) }
}

/** Static weights of the package that are among DOCUMENT_FONT_WEIGHTS (`upTo` = its heaviest cut). */
function upTo(slug: string, heaviest: number): FontsourceSource {
  return staticWeights(slug, DOCUMENT_FONT_WEIGHTS.filter(w => w <= heaviest))
}

/** What `scripts/build-bundled-fonts.py` keeps: Latin, Latin Extended, punctuation, currency, arrows, math operators. */
const BUNDLED_RANGE = 'U+0000-024F, U+02B0-036F, U+1E00-1EFF, U+2000-22FF, U+25A0-25FF, U+FB00-FB06, U+FEFF, U+FFFD'
/** Greek + Greek Extended. */
const GREEK_RANGE = 'U+0370-03FF, U+1F00-1FFF'

type FaceSpec = [file: string, style: 'normal' | 'italic', weight: number]

/** Bundled family: `fonts/<slug>/<prefix>-<style>.woff2` (GUST Font License families from CTAN). */
function bundled(version: string, faces: readonly FaceSpec[], opts: { greek?: 'own' | readonly FaceSpec[] } = {}): BundledSource {
  const own = faces.map(([file, style, weight]): BundledFace => ({ file, style, weight }))
  // Greek companion files (CM Unicode, OFL) for families without lower-case Greek.
  const companions = Array.isArray(opts.greek)
    ? opts.greek.map(([file, style, weight]): BundledFace => ({ file, style, weight, unicodeRange: GREEK_RANGE, licence: 'LICENSE-CMU.txt' }))
    : []
  return {
    kind: 'bundled',
    version,
    unicodeRange: opts.greek === 'own' ? `${BUNDLED_RANGE}, ${GREEK_RANGE}` : BUNDLED_RANGE,
    faces: [...own, ...companions]
  }
}

function font(name: string, category: FontCategory, slug: string, source: FontSource, opts: { picker?: boolean, ui?: FontsourceSource } = {}): SelfHostedFont {
  return { name, category, slug, source, picker: opts.picker ?? true, ...(opts.ui ? { ui: opts.ui } : {}) }
}

export const SELF_HOSTED_FONTS: readonly SelfHostedFont[] = [
  // Sans-serif: modern, neutral
  font('Inter', 'sans', 'inter', staticWeights('inter'), { ui: variable('inter') }),
  font('Roboto', 'sans', 'roboto', staticWeights('roboto')),
  font('Open Sans', 'sans', 'open-sans', upTo('open-sans', 800)),
  font('Lato', 'sans', 'lato', staticWeights('lato', [400, 700])),
  font('Source Sans 3', 'sans', 'source-sans-3', staticWeights('source-sans-3')),
  font('IBM Plex Sans', 'sans', 'ibm-plex-sans', upTo('ibm-plex-sans', 700)),
  font('Work Sans', 'sans', 'work-sans', staticWeights('work-sans')),
  font('Nunito', 'sans', 'nunito', staticWeights('nunito')),
  font('DM Sans', 'sans', 'dm-sans', staticWeights('dm-sans')),
  font('Karla', 'sans', 'karla', upTo('karla', 800)),

  // Serif: readable for long-form
  font('Source Serif 4', 'serif', 'source-serif-4', staticWeights('source-serif-4')),
  font('Merriweather', 'serif', 'merriweather', staticWeights('merriweather')),
  font('Playfair Display', 'serif', 'playfair-display', staticWeights('playfair-display')),
  font('Lora', 'serif', 'lora', upTo('lora', 700)),
  font('PT Serif', 'serif', 'pt-serif', staticWeights('pt-serif', [400, 700])),
  font('Crimson Text', 'serif', 'crimson-text', staticWeights('crimson-text', [400, 600, 700])),
  font('Libre Baskerville', 'serif', 'libre-baskerville', upTo('libre-baskerville', 700)),
  font('EB Garamond', 'serif', 'eb-garamond', upTo('eb-garamond', 800)),
  font('Cormorant Garamond', 'serif', 'cormorant-garamond', upTo('cormorant-garamond', 700)),
  font('IBM Plex Serif', 'serif', 'ibm-plex-serif', staticWeights('ibm-plex-serif', [400, 500, 600, 700])),

  // Not in the picker: the app shell's brand fonts (`--font-mono`,
  // `--font-serif` in app/assets/css/main.css) and the theme presets'
  // meta / heading fonts (shared/utils/theme/themePresets.ts, defaultTheme.ts).
  // The app shell keeps their variable cuts (Fraunces' optical-size axis
  // for the brand's display cuts); documents get the static ones.
  font('JetBrains Mono', 'mono', 'jetbrains-mono', upTo('jetbrains-mono', 800), { picker: false, ui: variable('jetbrains-mono') }),
  font('IBM Plex Mono', 'mono', 'ibm-plex-mono', staticWeights('ibm-plex-mono', [400, 500, 600, 700]), { picker: false }),
  font('Fraunces', 'serif', 'fraunces', staticWeights('fraunces'), { picker: false, ui: variable('fraunces', 'opsz') }),

  // Bundled (not on Fontsource): the TeX look, Times / Helvetica clones
  // of the TeX Gyre collection and Latin Modern (Computer Modern), GUST
  // Font License, committed in fonts/<slug>/. TeX Gyre carries its own
  // Greek; Latin Modern (capitals only) gets Greek companion files cut
  // from CM Unicode (OFL), so "3 μm" never falls back to a system font.
  font('TeX Gyre Termes', 'serif', 'tex-gyre-termes', bundled('2.004-2', [
    ['termes-regular.woff2', 'normal', 400], ['termes-italic.woff2', 'italic', 400],
    ['termes-bold.woff2', 'normal', 700], ['termes-bolditalic.woff2', 'italic', 700]
  ], { greek: 'own' })),
  font('TeX Gyre Heros', 'sans', 'tex-gyre-heros', bundled('2.004-2', [
    ['heros-regular.woff2', 'normal', 400], ['heros-italic.woff2', 'italic', 400],
    ['heros-bold.woff2', 'normal', 700], ['heros-bolditalic.woff2', 'italic', 700]
  ], { greek: 'own' })),
  font('Latin Modern Roman', 'serif', 'latin-modern-roman', bundled('2.004', [
    ['lmroman-regular.woff2', 'normal', 400], ['lmroman-italic.woff2', 'italic', 400],
    ['lmroman-bold.woff2', 'normal', 700], ['lmroman-bolditalic.woff2', 'italic', 700]
  ], { greek: [
    ['cmu-greek-regular.woff2', 'normal', 400], ['cmu-greek-italic.woff2', 'italic', 400],
    ['cmu-greek-bold.woff2', 'normal', 700], ['cmu-greek-bolditalic.woff2', 'italic', 700]
  ] })),
  // Monospace: offered in the code-font picker (CODE_FONT_NAMES), not
  // in the text pickers.
  font('Latin Modern Mono', 'mono', 'latin-modern-mono', bundled('2.004', [
    ['lmmono-regular.woff2', 'normal', 400], ['lmmono-italic.woff2', 'italic', 400],
    ['lmmono-bold.woff2', 'normal', 700]
  ], { greek: [
    ['cmu-greek-regular.woff2', 'normal', 400], ['cmu-greek-italic.woff2', 'italic', 400],
    ['cmu-greek-bold.woff2', 'normal', 700]
  ] }), { picker: false })
]

/** Families offered for `code.font` (every one is a self-hosted mono family). */
export const CODE_FONT_NAMES = ['JetBrains Mono', 'IBM Plex Mono', 'Latin Modern Mono'] as const

/** Folder (repo root) holding the bundled families' files. */
export const BUNDLED_FONTS_DIR = 'fonts'

/** Curated list shown in the theme editor's font pickers. */
export const THEME_FONTS: ThemeFont[] = SELF_HOSTED_FONTS
  .filter(f => f.picker)
  .map(({ name, category }) => ({ name, category }))

/** Every self-hosted family's stylesheet lives under this path. */
export const FONT_STYLESHEET_BASE = '/vendor/fonts/'

const BY_NAME = new Map(SELF_HOSTED_FONTS.map(f => [f.name.toLowerCase(), f]))

/** The self-hosted family with this CSS name (case-insensitive, trimmed), or null. */
export function selfHostedFont(name: string | null | undefined): SelfHostedFont | null {
  return BY_NAME.get((name ?? '').trim().toLowerCase()) ?? null
}

/** Same-origin stylesheet URL with the @font-face rules for `name`, or null when the family isn't self-hosted. */
export function fontStylesheetUrl(name: string | null | undefined): string | null {
  const f = selfHostedFont(name)
  return f ? `${FONT_STYLESHEET_BASE}${f.slug}.css` : null
}

/** Unique stylesheet URLs for a list of family names (unknown families skipped). */
export function fontStylesheetUrls(names: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(names.map(fontStylesheetUrl).filter((u): u is string => u !== null))]
}

/**
 * CSS family name of the app shell's variable cut: `'Inter Variable'`, not
 * `'Inter'`. Under the theme's name it would join the document's static
 * faces in the same page, the server render page is an app page, and
 * win the font matching, so the PDF would embed the variable font as
 * Type 3 again.
 */
export function uiFontFamilyName(font: SelfHostedFont): string {
  return font.ui ? `${font.name} Variable` : font.name
}

/** File name of a family's app-shell stylesheet (variable cut) under FONT_STYLESHEET_BASE. */
export function uiFontStylesheetName(font: SelfHostedFont): string {
  return font.ui ? `${font.slug}.variable.css` : `${font.slug}.css`
}

/**
 * Stylesheets for the app shell's own text (not documents): the variable
 * cut where the family has one, else the document stylesheet.
 */
export function uiFontStylesheetUrls(names: ReadonlyArray<string>): string[] {
  return [...new Set(names.map(selfHostedFont).filter((f): f is SelfHostedFont => f !== null).map(f => `${FONT_STYLESHEET_BASE}${uiFontStylesheetName(f)}`))]
}
