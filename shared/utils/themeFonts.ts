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
export interface FontSource {
  /** npm package (pinned exactly in package.json devDependencies). */
  package: string
  /** Stylesheets inside the package (each a list of per-subset @font-face rules). */
  stylesheets: readonly string[]
}

export interface SelfHostedFont extends ThemeFont {
  /** URL-safe id; also the file name of the family's stylesheet. */
  slug: string
  source: FontSource
  /** Listed in the theme editor's font pickers. */
  picker: boolean
}

/** Variable font: one file per subset and style covers every weight. */
function variable(slug: string, axis: 'wght' | 'opsz' = 'wght'): FontSource {
  return { package: `@fontsource-variable/${slug}`, stylesheets: [`${axis}.css`, `${axis}-italic.css`] }
}

/** Static font: one file per subset, weight and style. */
function staticWeights(slug: string, weights: readonly number[]): FontSource {
  return { package: `@fontsource/${slug}`, stylesheets: weights.flatMap(w => [`${w}.css`, `${w}-italic.css`]) }
}

function font(name: string, category: FontCategory, slug: string, source: FontSource, picker = true): SelfHostedFont {
  return { name, category, slug, source, picker }
}

export const SELF_HOSTED_FONTS: readonly SelfHostedFont[] = [
  // Sans-serif — modern, neutral
  font('Inter', 'sans', 'inter', variable('inter')),
  font('Roboto', 'sans', 'roboto', variable('roboto')),
  font('Open Sans', 'sans', 'open-sans', variable('open-sans')),
  font('Lato', 'sans', 'lato', staticWeights('lato', [400, 700])),
  font('Source Sans 3', 'sans', 'source-sans-3', variable('source-sans-3')),
  font('IBM Plex Sans', 'sans', 'ibm-plex-sans', variable('ibm-plex-sans')),
  font('Work Sans', 'sans', 'work-sans', variable('work-sans')),
  font('Nunito', 'sans', 'nunito', variable('nunito')),
  font('DM Sans', 'sans', 'dm-sans', variable('dm-sans')),
  font('Karla', 'sans', 'karla', variable('karla')),

  // Serif — readable for long-form
  font('Source Serif 4', 'serif', 'source-serif-4', variable('source-serif-4')),
  font('Merriweather', 'serif', 'merriweather', variable('merriweather')),
  font('Playfair Display', 'serif', 'playfair-display', variable('playfair-display')),
  font('Lora', 'serif', 'lora', variable('lora')),
  font('PT Serif', 'serif', 'pt-serif', staticWeights('pt-serif', [400, 700])),
  font('Crimson Text', 'serif', 'crimson-text', staticWeights('crimson-text', [400, 600, 700])),
  font('Libre Baskerville', 'serif', 'libre-baskerville', variable('libre-baskerville')),
  font('EB Garamond', 'serif', 'eb-garamond', variable('eb-garamond')),
  font('Cormorant Garamond', 'serif', 'cormorant-garamond', variable('cormorant-garamond')),
  font('IBM Plex Serif', 'serif', 'ibm-plex-serif', staticWeights('ibm-plex-serif', [400, 500, 600, 700])),

  // Not in the picker: the app shell's brand fonts (`--font-mono`,
  // `--font-serif` in app/assets/css/main.css) and the theme presets'
  // meta / heading fonts (shared/utils/themePresets.ts, defaultTheme.ts).
  // Fraunces keeps its optical-size axis (the brand's display cuts).
  font('JetBrains Mono', 'mono', 'jetbrains-mono', variable('jetbrains-mono'), false),
  font('IBM Plex Mono', 'mono', 'ibm-plex-mono', staticWeights('ibm-plex-mono', [400, 500, 600, 700]), false),
  font('Fraunces', 'serif', 'fraunces', variable('fraunces', 'opsz'), false)
]

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
