import { trimChars } from '../utils/trimChars'
// Marketing pages (hosted markoto.app only): routes, language versions,
// hreflang and indexing rules. Pure, shared by the marketing pages, the
// URL-locale plugin (app/plugins/marketing-locale.ts), the route setup in
// nuxt.config.ts and the sitemap.
//
// Two kinds of public marketing page, both with one URL per language:
//  - UI pages: Vue pages whose text comes from the locale files (`/`,
//    `/pricing`, `/demo`, MARKETING_UI_PAGES). They exist in every UI
//    language; nuxt.config.ts adds a route per prefixed language
//    (`/de`, `/de/pricing`, ...; marketingUiRoutes()).
//  - Content pages: content/marketing/<locale>/<slug>.md (Nuxt Content
//    collection `marketing`, content path `/marketing/<locale>/<slug>`),
//    rendered by app/pages/[...marketing].vue. They exist in the languages
//    that have a file.
// English at the root (`/pricing`, `/<slug>`), every other language under
// its prefix (`/de/pricing`, `/fr/<slug>`). On these URLs the UI language
// follows the URL, never the cookie or Accept-Language. The app itself
// (editor, workspaces, settings, docs, ...) stays `no_prefix` with the
// cookie-based UI language.

/**
 * Languages marketing pages can exist in: the UI languages (`i18n.locales`
 * in nuxt.config.ts, pinned by tests/unit/seo/marketingLocales.test.ts).
 * The first one is the default (x-default, no prefix).
 */
export const MARKETING_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type MarketingLocale = typeof MARKETING_LOCALES[number]

export const DEFAULT_MARKETING_LOCALE: MarketingLocale = 'en'

/** Locales whose pages live under `/<locale>/…`. */
export const PREFIXED_MARKETING_LOCALES = ['de', 'fr', 'es', 'ja', 'zh'] as const
export type PrefixedMarketingLocale = typeof PREFIXED_MARKETING_LOCALES[number]

/**
 * UI languages whose texts on the UI pages (product tour, pricing, demo;
 * `tour.*`, `pricing.*`, `demo.*`, `landing.*` in i18n/locales/) a native
 * speaker has read. The others are served with `noindex`, stay out of the
 * sitemap and get no hreflang, like a content page with `reviewed: false`.
 * Add a language here once its review is done.
 */
export const REVIEWED_UI_LOCALES: readonly MarketingLocale[] = ['en']

/** The UI pages: route paths of their English versions. */
export const MARKETING_UI_PAGES = ['/', '/pricing', '/demo'] as const
export type MarketingUiPage = typeof MARKETING_UI_PAGES[number]

/**
 * Router names of the pages whose UI language follows the URL: the UI
 * pages (and their per-language copies, `<name>-<locale>`) and the
 * content catch-all. `index` only for signed-out visitors: signed in, `/`
 * is the dashboard, which is the app.
 */
const UI_PAGE_ROUTE_NAMES: Readonly<Record<MarketingUiPage, string>> = { '/': 'index', '/pricing': 'pricing', '/demo': 'demo' }
const CONTENT_ROUTE_NAME = 'marketing'

/** Router name of a UI page's copy in a prefixed language. */
export function localisedRouteName(name: string, locale: PrefixedMarketingLocale): string {
  return `${name}-${locale}`
}

/** The install guide in the docs: where "Self-host" points off the marketing site. */
const SELF_HOST_DOCS_PATH = '/docs/self-hosting'
/** The self-hosting page of the marketing site (content/marketing/en/self-hosted-markdown-editor.md, not in the Use cases menu). */
const SELF_HOST_MARKETING_PATH = '/self-hosted-markdown-editor'

/** Target of the header + footer "Self-host" link. */
export function selfHostPath(marketingSite: boolean): string {
  return marketingSite ? SELF_HOST_MARKETING_PATH : SELF_HOST_DOCS_PATH
}

const CONTENT_ROOT = '/marketing'
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export interface MarketingTarget {
  locale: MarketingLocale
  slug: string
}

function isPrefixedLocale(value: string | undefined): value is PrefixedMarketingLocale {
  return PREFIXED_MARKETING_LOCALES.some(l => l === value)
}

function isMarketingLocale(value: string | undefined): value is MarketingLocale {
  return MARKETING_LOCALES.some(l => l === value)
}

function trimSlashes(path: string): string {
  return trimChars(path, '/')
}

/**
 * The language a route path's locale prefix names (`/de/…`, bare `/de`)
 * and the path without it; English and the path itself otherwise.
 * `/de/pricing` → de + `/pricing`; `/de` → de + `/`; `/pricing` → en.
 */
export function splitMarketingLocale(path: string): { locale: MarketingLocale, path: string } {
  const pathname = path.split(/[?#]/)[0] ?? ''
  const parts = trimSlashes(pathname).split('/')
  const first = parts[0]
  if (isPrefixedLocale(first)) return { locale: first, path: `/${parts.slice(1).join('/')}` }
  return { locale: DEFAULT_MARKETING_LOCALE, path: pathname || '/' }
}

/** A route path in a language: `('de', '/pricing')` → `/de/pricing`, `('de', '/')` → `/de`. */
export function localisedPath(locale: MarketingLocale, path: string): string {
  const clean = `/${trimSlashes(path)}`
  if (locale === DEFAULT_MARKETING_LOCALE) return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

export interface UrlLocaleInput {
  /** Router name of the matched route. */
  routeName: string | null | undefined
  /** Route path. */
  path: string
  /** NUXT_MARKETING_SITE_ENABLED. */
  marketingSite: boolean
  /** A signed-in visitor (`/` is their dashboard). */
  signedIn: boolean
}

/** True when `name` is a UI page's route or one of its per-language copies. */
function isUiPageRoute(name: string, base: string): boolean {
  return name === base || PREFIXED_MARKETING_LOCALES.some(l => name === localisedRouteName(base, l))
}

/** The UI page a router name belongs to, or null. */
export function uiPageOfRoute(name: string | null | undefined): MarketingUiPage | null {
  if (!name) return null
  return MARKETING_UI_PAGES.find(page => isUiPageRoute(name, UI_PAGE_ROUTE_NAMES[page])) ?? null
}

/**
 * The UI language a route's URL fixes, or null when the route keeps the
 * visitor's language (cookie / Accept-Language): every route off the
 * marketing site, the app's routes, and `/` for signed-in visitors.
 */
export function marketingUrlLocale(input: UrlLocaleInput): MarketingLocale | null {
  if (!input.marketingSite || !input.routeName) return null
  const page = uiPageOfRoute(input.routeName)
  if (page === '/' && input.signedIn) return null
  if (!page && input.routeName !== CONTENT_ROUTE_NAME) return null
  return splitMarketingLocale(input.path).locale
}

/** True for a UI page's per-language copy (`/de/pricing`): 404 off the marketing site. */
export function isLocalisedUiRoute(name: string | null | undefined): boolean {
  if (!name) return false
  return MARKETING_UI_PAGES.some(page => PREFIXED_MARKETING_LOCALES.some(l => name === localisedRouteName(UI_PAGE_ROUTE_NAMES[page], l)))
}

/** The minimal route shape `marketingUiRoutes` works on (Nuxt's NuxtPage). */
export interface PageRoute {
  name?: string
  path: string
  file?: string
  alias?: string[] | string
  children?: PageRoute[]
  [key: string]: unknown
}

/**
 * Per-language copies of the UI pages (`pages:extend` in nuxt.config.ts):
 * `/de`, `/de/pricing`, `/de/demo`, ... with the same component. Aliases
 * (the dashboard's `/f/:folderId`) are not copied.
 */
export function marketingUiRoutes(pages: readonly PageRoute[]): PageRoute[] {
  const out: PageRoute[] = []
  for (const uiPath of MARKETING_UI_PAGES) {
    const page = pages.find(p => p.name === UI_PAGE_ROUTE_NAMES[uiPath])
    if (!page) continue
    for (const locale of PREFIXED_MARKETING_LOCALES) {
      const { alias: _alias, ...rest } = page
      out.push({ ...rest, name: localisedRouteName(UI_PAGE_ROUTE_NAMES[uiPath], locale), path: localisedPath(locale, uiPath) })
    }
  }
  return out
}

/**
 * The marketing language a visitor prefers: the locale cookie when it
 * names one, else the first of the browser's languages that matches one
 * (`de-CH` → `de`), else null. Drives the language suggestion only, never
 * which language a URL is served in.
 */
export function preferredMarketingLocale(cookie: string | null | undefined, browserLanguages: readonly string[]): MarketingLocale | null {
  const chosen = cookie ?? undefined
  if (isMarketingLocale(chosen)) return chosen
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split('-')[0]
    if (isMarketingLocale(primary)) return primary
  }
  return null
}

/** One language version of a page. */
export interface MarketingVariant {
  locale: MarketingLocale
  /** Route path. */
  path: string
  /** Reviewed: indexable, in hreflang and the sitemap. */
  indexable: boolean
}

/** Whether the UI pages' texts in a language are reviewed (REVIEWED_UI_LOCALES). */
export function isReviewedUiLocale(locale: MarketingLocale): boolean {
  return REVIEWED_UI_LOCALES.includes(locale)
}

/** The language versions of a UI page: every UI language. */
export function uiPageVariants(page: MarketingUiPage): MarketingVariant[] {
  return MARKETING_LOCALES.map(locale => ({ locale, path: localisedPath(locale, page), indexable: isReviewedUiLocale(locale) }))
}

/** The language versions of a content page: the languages with a file, in MARKETING_LOCALES order. */
export function contentPageVariants(slug: string, versions: MarketingVersion[]): MarketingVariant[] {
  const found = new Map<MarketingLocale, boolean>()
  for (const version of versions) {
    const target = parseMarketingContentPath(version.path)
    if (target?.slug === slug) found.set(target.locale, isIndexableVersion(version))
  }
  return MARKETING_LOCALES
    .filter(locale => found.has(locale))
    .map(locale => ({ locale, path: marketingRoutePath(locale, slug), indexable: found.get(locale) === true }))
}

/**
 * hreflang alternates of a page shown in `current`: every indexable
 * version, plus `x-default` → English when English is one of them. None
 * when the page itself isn't indexable (an unreviewed translation is
 * noindex; alternates pointing at or from it are an error for search
 * engines).
 */
export function variantAlternates(variants: readonly MarketingVariant[], current: MarketingLocale): HreflangLink[] {
  if (!variants.some(v => v.locale === current && v.indexable)) return []
  const links: HreflangLink[] = variants.filter(v => v.indexable).map(v => ({ hreflang: v.locale, path: v.path }))
  const fallback = variants.find(v => v.locale === DEFAULT_MARKETING_LOCALE && v.indexable)
  if (fallback) links.push({ hreflang: 'x-default', path: fallback.path })
  return links
}

/**
 * Which marketing page a route path asks for, or null when the path
 * can't be one (bad characters, a bare locale prefix like `/de`).
 * `/markdown-cheat-sheet` → en; `/de/markdown-cheat-sheet` → de.
 */
export function parseMarketingRoute(path: string): MarketingTarget | null {
  const parts = trimSlashes(path.split(/[?#]/)[0] ?? '').split('/')
  const first = parts[0]
  const prefixed = isPrefixedLocale(first)
  const slug = (prefixed ? parts.slice(1) : parts).join('/')
  if (!SLUG_RE.test(slug)) return null
  return { locale: prefixed ? first : DEFAULT_MARKETING_LOCALE, slug }
}

/** Route path of a page in a language. */
export function marketingRoutePath(locale: MarketingLocale, slug: string): string {
  return locale === DEFAULT_MARKETING_LOCALE ? `/${slug}` : `/${locale}/${slug}`
}

/** Nuxt Content path of a page in a language. */
export function marketingContentPath(locale: MarketingLocale, slug: string): string {
  return `${CONTENT_ROOT}/${locale}/${slug}`
}

/** Inverse of `marketingContentPath`; null for anything else. */
export function parseMarketingContentPath(contentPath: string): MarketingTarget | null {
  const prefix = `${CONTENT_ROOT}/`
  if (!contentPath.startsWith(prefix)) return null
  const [locale, ...rest] = contentPath.slice(prefix.length).split('/')
  const slug = rest.join('/')
  if (!isMarketingLocale(locale) || !SLUG_RE.test(slug)) return null
  return { locale, slug }
}

/** The fields of a marketing item the language rules look at. */
export interface MarketingVersion {
  /** Nuxt Content path (`/marketing/<locale>/<slug>`). */
  path: string
  /** `reviewed: false` in frontmatter = machine draft, not read by a native speaker yet. */
  reviewed?: boolean | null
  /** Frontmatter `updated` (YYYY-MM-DD), for the sitemap's `<lastmod>`. */
  updated?: string | null
}

/**
 * Whether a version may be indexed. Translations stay `noindex` (and out
 * of the sitemap) until a native speaker has read them; English pages
 * are written as reviewed unless they say otherwise.
 */
export function isIndexableVersion(version: Pick<MarketingVersion, 'reviewed'>): boolean {
  return version.reviewed !== false
}

export interface HreflangLink {
  /** `en`, `de`, `fr` or `x-default`. */
  hreflang: string
  /** Route path. */
  path: string
}

/** Indexable language versions grouped per slug: `{ slug: { en: '/slug', de: '/de/slug' } }`. */
export function indexableMarketingPages(versions: MarketingVersion[]): Map<string, Partial<Record<MarketingLocale, string>>> {
  const pages = new Map<string, Partial<Record<MarketingLocale, string>>>()
  for (const version of versions) {
    const target = parseMarketingContentPath(version.path)
    if (!target || !isIndexableVersion(version)) continue
    const paths = pages.get(target.slug) ?? {}
    paths[target.locale] = marketingRoutePath(target.locale, target.slug)
    pages.set(target.slug, paths)
  }
  return pages
}

/** Slug of the comparison hub (`/compare`); comparison pages live under it. */
export const COMPARE_HUB_SLUG = 'compare'
/** Breadcrumb name of the hub (the header menu's label). */
export const COMPARE_HUB_CRUMB = 'Compare'

/**
 * What kind of marketing page a slug is: the comparison hub, a
 * comparison page, or anything else (use cases, the cheat sheet). Drives
 * the social card, og:type and the JSON-LD shape.
 */
export function marketingPageKind(slug: string): 'hub' | 'page' | 'other' {
  if (slug === COMPARE_HUB_SLUG) return 'hub'
  if (slug.startsWith(`${COMPARE_HUB_SLUG}/`)) return 'page'
  return 'other'
}
