// sitemap.xml for the hosted marketing site (server/routes/sitemap.xml.ts).
//
// Only markoto.app publishes one (`NUXT_MARKETING_SITE_ENABLED`): a
// self-hosted instance has nothing to advertise to search engines beyond
// its copy of the docs, whose canonicals point at markoto.app anyway.
// Absolute URLs come from `NUXT_SITE_URL` — never the request Host — so
// without it there is no sitemap either.
//
// Pure helpers; the route gathers the docs paths from Nuxt Content.

import { resolveMarketingSiteEnabled, resolveSiteUrl } from '../../shared/config/instance'
import {
  DEFAULT_MARKETING_LOCALE,
  indexableMarketingPages,
  MARKETING_LOCALES,
  type MarketingVersion
} from '../../shared/seo/marketing'

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
}

/** Legal pages that exist while the legal surfaces are on (hosted). */
export const LEGAL_SITEMAP_PATHS = [
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
  '/legal/abuse-policy',
  '/legal/imprint',
  '/legal/sub-processors'
] as const

/** Fixed top-level pages of the marketing site. */
export const STATIC_SITEMAP_PATHS = ['/', '/pricing', '/docs'] as const

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
}

/**
 * Sitemap pages of the `marketing` content collection: one per slug with
 * its indexable language versions. Unreviewed translations
 * (`reviewed: false`) are `noindex` and stay out, as alternates too.
 */
export function marketingSitemapPages(versions: MarketingVersion[]): LocalisedPage[] {
  return [...indexableMarketingPages(versions).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, paths]) => {
      const clean: Record<string, string> = {}
      for (const locale of MARKETING_LOCALES) {
        const path = paths[locale]
        if (path) clean[locale] = path
      }
      return { paths: clean, defaultLanguage: DEFAULT_MARKETING_LOCALE }
    })
}

/**
 * Origin the sitemap's URLs are built on, or null when this instance
 * publishes no sitemap (not the marketing site, or no valid site URL).
 */
export function sitemapBaseUrl(env: Env): string | null {
  if (!resolveMarketingSiteEnabled(env)) return null
  return resolveSiteUrl(env) || null
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
  const alternates: SitemapAlternate[] = Object.entries(page.paths)
    .map(([hreflang, path]) => ({ hreflang, href: `${base}${path}` }))
  const defaultPath = page.paths[page.defaultLanguage]
  if (defaultPath) alternates.push({ hreflang: 'x-default', href: `${base}${defaultPath}` })
  return Object.values(page.paths).map(path => ({ loc: `${base}${path}`, alternates }))
}

export interface SitemapSources {
  /** Route paths of the docs pages (`/docs/...`). */
  docsPaths: string[]
  /** Legal pages exist (legal surfaces on). */
  legalSurfaces: boolean
  /** Localised marketing pages (`marketingSitemapPages`). */
  marketingPages?: LocalisedPage[]
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
  for (const path of STATIC_SITEMAP_PATHS) add({ loc: path === '/' ? `${base}/` : `${base}${path}` })
  for (const page of sources.marketingPages ?? []) localisedEntries(base, page).forEach(add)
  for (const path of [...sources.docsPaths].sort()) add({ loc: `${base}${path}` })
  if (sources.legalSurfaces) for (const path of LEGAL_SITEMAP_PATHS) add({ loc: `${base}${path}` })
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
    for (const alt of entry.alternates ?? []) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`)
    }
    lines.push('  </url>')
  }
  lines.push('</urlset>', '')
  return lines.join('\n')
}
