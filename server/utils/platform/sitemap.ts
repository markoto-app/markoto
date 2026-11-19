// sitemap.xml for the hosted marketing site (server/routes/sitemap.xml.ts).
//
// Only markoto.app publishes one (`NUXT_MARKETING_SITE_ENABLED`): a
// self-hosted instance has nothing to advertise to search engines beyond
// its copy of the docs, whose canonicals point at markoto.app anyway.
// Absolute URLs come from `NUXT_SITE_URL`, never the request Host, so
// without it there is no sitemap either.
//
// Pure helpers; the route gathers the docs paths from Nuxt Content.

import { resolveCanonicalSiteUrl, resolveMarketingSiteEnabled } from '../../../shared/config/instance'
import {
  DEFAULT_MARKETING_LOCALE,
  indexableMarketingPages,
  MARKETING_LOCALES,
  MARKETING_UI_PAGES,
  uiPageVariants,
  type MarketingVersion
} from '../../../shared/seo/marketing'
import { isoDate } from '../../../shared/seo/structuredData'
import { compareCodeUnits } from '../../../shared/utils/compareCodeUnits'
import {
  ABUSE_POLICY_EFFECTIVE_DATE,
  DPA_EFFECTIVE_DATE,
  IMPRINT_EFFECTIVE_DATE,
  PRIVACY_EFFECTIVE_DATE,
  TOS_EFFECTIVE_DATE,
  PAID_TERMS_EFFECTIVE_DATE
} from '../../../shared/legal/versions'

type Env = Record<string, string | undefined>

export interface SitemapAlternate {
  /** BCP 47 language tag, or `x-default`. */
  hreflang: string
  href: string
}

export interface SitemapEntry {
  /** Absolute URL. */
  loc: string
  /** Language versions of the same page (`xhtml:link rel="alternate"`). */
  alternates?: SitemapAlternate[]
  /** Last substantive change, YYYY-MM-DD (frontmatter `updated`, legal effective date). */
  lastmod?: string
}

/** Legal pages that exist while the legal surfaces are on (hosted). */
export const LEGAL_SITEMAP_PATHS = [
  '/legal/privacy',
  '/legal/terms',
  '/legal/paid-terms',
  '/legal/dpa',
  '/legal/abuse-policy',
  '/legal/imprint',
  '/legal/sub-processors'
] as const

/**
 * `<lastmod>` of the legal pages: the effective date of the document's
 * current version (`shared/legal/versions.ts`). The sub-processor list
 * belongs to the privacy policy and changes with it.
 */
export const LEGAL_LASTMOD: Readonly<Record<string, string>> = Object.freeze({
  '/legal/privacy': PRIVACY_EFFECTIVE_DATE,
  '/legal/terms': TOS_EFFECTIVE_DATE,
  '/legal/paid-terms': PAID_TERMS_EFFECTIVE_DATE,
  '/legal/dpa': DPA_EFFECTIVE_DATE,
  '/legal/abuse-policy': ABUSE_POLICY_EFFECTIVE_DATE,
  '/legal/imprint': IMPRINT_EFFECTIVE_DATE,
  '/legal/sub-processors': PRIVACY_EFFECTIVE_DATE
})

/** Fixed top-level pages of the marketing site without language versions (the docs are English only). */
const STATIC_SITEMAP_PATHS = ['/docs'] as const

/**
 * A marketing page with language versions (the `marketing` content
 * collection, `/de/…`, `/fr/…` prefixes; `marketingSitemapPages()`). Each
 * becomes one entry per language, all listing every version (incl.
 * `x-default`) as alternates.
 */
export interface LocalisedPage {
  /** Path per language tag, e.g. `{ en: '/markdown-to-pdf', de: '/de/markdown-to-pdf' }`. */
  paths: Record<string, string>
  /** Language whose path is `x-default`. */
  defaultLanguage: string
  /** `<lastmod>` per language tag (frontmatter `updated`). */
  lastmod?: Record<string, string>
}

/**
 * Sitemap pages of the `marketing` content collection: one per slug with
 * its indexable language versions. Unreviewed translations
 * (`reviewed: false`) are `noindex` and stay out, as alternates too.
 */
export function marketingSitemapPages(versions: MarketingVersion[]): LocalisedPage[] {
  return [...indexableMarketingPages(versions).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, paths]) => {
      const clean: Record<string, string> = {}
      const lastmod: Record<string, string> = {}
      for (const locale of MARKETING_LOCALES) {
        const path = paths[locale]
        if (!path) continue
        clean[locale] = path
        const updated = isoDate(updatedOf(versions, locale, slug))
        if (updated) lastmod[locale] = updated
      }
      return Object.keys(lastmod).length
        ? { paths: clean, defaultLanguage: DEFAULT_MARKETING_LOCALE, lastmod }
        : { paths: clean, defaultLanguage: DEFAULT_MARKETING_LOCALE }
    })
}

/**
 * Sitemap pages of the UI pages (`/`, `/pricing`, `/demo`): one per page
 * with its reviewed language versions (REVIEWED_UI_LOCALES); the others
 * are `noindex` and stay out, as alternates too.
 */
export function uiSitemapPages(): LocalisedPage[] {
  return MARKETING_UI_PAGES.map((page) => {
    const paths: Record<string, string> = {}
    for (const variant of uiPageVariants(page)) if (variant.indexable) paths[variant.locale] = variant.path
    return { paths, defaultLanguage: DEFAULT_MARKETING_LOCALE }
  })
}

function updatedOf(versions: MarketingVersion[], locale: string, slug: string): string | undefined {
  const path = `/marketing/${locale}/${slug}`
  return versions.find(v => v.path === path)?.updated ?? undefined
}

/**
 * Origin the sitemap's URLs are built on, or null when this instance
 * publishes no sitemap (not the marketing site, or no valid site URL).
 */
export function sitemapBaseUrl(env?: Env): string | null {
  if (!resolveMarketingSiteEnabled(env)) return null
  return resolveCanonicalSiteUrl(env) || null
}

/**
 * Route path of a docs content item. Content paths of folder index pages
 * may end in `/index`; the page route doesn't.
 */
export function docsRoutePath(contentPath: string): string {
  const trimmed = contentPath.replace(/\/index$/, '')
  return trimmed || '/docs'
}

/** Entries for one localised page: one per language, each with every alternate. */
export function localisedEntries(base: string, page: LocalisedPage): SitemapEntry[] {
  // The home page's URL is `${base}/` (as before), its versions `${base}/de`.
  const href = (path: string): string => (path === '/' ? `${base}/` : `${base}${path}`)
  const alternates: SitemapAlternate[] = Object.entries(page.paths)
    .map(([hreflang, path]) => ({ hreflang, href: href(path) }))
  const defaultPath = page.paths[page.defaultLanguage]
  if (defaultPath) alternates.push({ hreflang: 'x-default', href: href(defaultPath) })
  return Object.entries(page.paths).map(([lang, path]) => {
    const lastmod = page.lastmod?.[lang]
    return lastmod ? { loc: href(path), alternates, lastmod } : { loc: href(path), alternates }
  })
}

export interface SitemapSources {
  /** Route paths of the docs pages (`/docs/...`). */
  docsPaths: string[]
  /** `<lastmod>` per docs route path (frontmatter `updated`). */
  docsLastmod?: Record<string, string>
  /** Legal pages exist (legal surfaces on). */
  legalSurfaces: boolean
  /** Localised marketing pages (`marketingSitemapPages`). */
  marketingPages?: LocalisedPage[]
  /** The UI pages (`uiSitemapPages`); default: `uiSitemapPages()`. */
  uiPages?: LocalisedPage[]
}

function withLastmod(loc: string, lastmod: string | undefined): SitemapEntry {
  const date = isoDate(lastmod)
  return date ? { loc, lastmod: date } : { loc }
}

/** Every sitemap entry, deduplicated, in a stable order. */
export function sitemapEntries(base: string, sources: SitemapSources): SitemapEntry[] {
  const seen = new Set<string>()
  const out: SitemapEntry[] = []
  const add = (entry: SitemapEntry): void => {
    if (seen.has(entry.loc)) return
    seen.add(entry.loc)
    out.push(entry)
  }
  for (const page of sources.uiPages ?? uiSitemapPages()) localisedEntries(base, page).forEach(add)
  for (const path of STATIC_SITEMAP_PATHS) add({ loc: `${base}${path}` })
  for (const page of sources.marketingPages ?? []) localisedEntries(base, page).forEach(add)
  for (const path of [...sources.docsPaths].sort(compareCodeUnits)) add(withLastmod(`${base}${path}`, sources.docsLastmod?.[path]))
  if (sources.legalSurfaces) for (const path of LEGAL_SITEMAP_PATHS) add(withLastmod(`${base}${path}`, LEGAL_LASTMOD[path]))
  return out
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

/** sitemap.xml document (sitemaps.org 0.9 + xhtml:link alternates). */
export function buildSitemapXml(entries: SitemapEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
  ]
  for (const entry of entries) {
    lines.push('  <url>', `    <loc>${escapeXml(entry.loc)}</loc>`)
    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)
    for (const alt of entry.alternates ?? []) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`)
    }
    lines.push('  </url>')
  }
  lines.push('</urlset>', '')
  return lines.join('\n')
}
