import { trimChars } from '../utils/trimChars'
// Marketing pages (hosted markoto.app only): routes, language versions,
// hreflang and indexing rules. Pure — shared by the catch-all page
// (app/pages/[...marketing].vue), the URL-locale plugin and the sitemap.
//
// Files: content/marketing/<locale>/<slug>.md (Nuxt Content collection
// `marketing`, content path `/marketing/<locale>/<slug>`).
// Routes: English at the root (`/<slug>`), translations under a locale
// prefix (`/de/<slug>`, `/fr/<slug>`). Only marketing pages get prefixes;
// the app itself stays `no_prefix` with the cookie-based UI language.

/** Languages marketing pages can exist in. The first one is the default (x-default, no prefix). */
export const MARKETING_LOCALES = ['en', 'de', 'fr'] as const
export type MarketingLocale = typeof MARKETING_LOCALES[number]

export const DEFAULT_MARKETING_LOCALE: MarketingLocale = 'en'

/** Locales whose pages live under `/<locale>/…`. */
export const PREFIXED_MARKETING_LOCALES = ['de', 'fr'] as const
export type PrefixedMarketingLocale = typeof PREFIXED_MARKETING_LOCALES[number]

/** The install guide in the docs: where "Self-host" points off the marketing site. */
const SELF_HOST_DOCS_PATH = '/docs/getting-started/self-hosting'
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
 * The language a route path's locale prefix names (`/de/…` → `de`), or
 * null. Used by the URL-locale plugin: on these routes the UI language
 * follows the URL, not the cookie.
 */
export function prefixedMarketingLocale(path: string): PrefixedMarketingLocale | null {
  const pathname = path.split(/[?#]/)[0] ?? ''
  const first = trimSlashes(pathname).split('/')[0]
  const rest = trimSlashes(pathname).split('/').slice(1).join('/')
  return isPrefixedLocale(first) && SLUG_RE.test(rest) ? first : null
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

/**
 * hreflang alternates for one slug: every indexable language version
 * that exists, in MARKETING_LOCALES order, plus `x-default` → English
 * when the English version is among them. Unreviewed translations are
 * left out — an alternate pointing at a noindex page is an error for
 * search engines.
 */
export function hreflangLinks(slug: string, versions: MarketingVersion[]): HreflangLink[] {
  const available = new Set<MarketingLocale>()
  for (const version of versions) {
    const target = parseMarketingContentPath(version.path)
    if (target?.slug === slug && isIndexableVersion(version)) available.add(target.locale)
  }
  const links: HreflangLink[] = MARKETING_LOCALES
    .filter(locale => available.has(locale))
    .map(locale => ({ hreflang: locale, path: marketingRoutePath(locale, slug) }))
  if (available.has(DEFAULT_MARKETING_LOCALE)) {
    links.push({ hreflang: 'x-default', path: marketingRoutePath(DEFAULT_MARKETING_LOCALE, slug) })
  }
  return links
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
