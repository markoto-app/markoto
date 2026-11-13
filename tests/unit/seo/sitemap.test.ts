import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  LEGAL_SITEMAP_PATHS,
  buildSitemapXml,
  docsRoutePath,
  localisedEntries,
  marketingSitemapPages,
  sitemapBaseUrl,
  sitemapEntries
} from '../../../server/utils/platform/sitemap'

// sitemap.xml: hosted marketing site only, absolute URLs from
// NUXT_SITE_URL (server/utils/platform/sitemap.ts).

const BASE = 'https://markoto.app'

describe('sitemapBaseUrl', () => {
  it('is null unless the marketing site is on AND a site URL is set', () => {
    expect(sitemapBaseUrl({})).toBeNull()
    expect(sitemapBaseUrl({ NUXT_SITE_URL: BASE })).toBeNull()
    expect(sitemapBaseUrl({ NUXT_MARKETING_SITE_ENABLED: 'true' })).toBeNull()
    expect(sitemapBaseUrl({ NUXT_MARKETING_SITE_ENABLED: 'true', NUXT_SITE_URL: 'https://markoto.app/' })).toBe(BASE)
  })
})

describe('docsRoutePath', () => {
  it('strips the /index of folder pages', () => {
    expect(docsRoutePath('/docs/themes/index')).toBe('/docs/themes')
    expect(docsRoutePath('/docs/themes/custom-css')).toBe('/docs/themes/custom-css')
    expect(docsRoutePath('/docs/index')).toBe('/docs')
  })
})

describe('sitemapEntries', () => {
  it('lists /, /pricing, /docs, the docs pages and (hosted) the legal pages, deduplicated', () => {
    const locs = sitemapEntries(BASE, {
      docsPaths: ['/docs/b', '/docs/a', '/docs'],
      legalSurfaces: true
    }).map(e => e.loc)
    expect(locs.slice(0, 3)).toEqual([`${BASE}/`, `${BASE}/pricing`, `${BASE}/docs`])
    expect(locs).toContain(`${BASE}/docs/a`)
    expect(locs).toContain(`${BASE}/legal/privacy`)
    expect(locs.filter(l => l === `${BASE}/docs`)).toHaveLength(1)
    expect(locs.indexOf(`${BASE}/docs/a`)).toBeLessThan(locs.indexOf(`${BASE}/docs/b`))
  })

  it('leaves the legal pages out when the legal surfaces are off', () => {
    const locs = sitemapEntries(BASE, { docsPaths: [], legalSurfaces: false }).map(e => e.loc)
    expect(locs.some(l => l.includes('/legal/'))).toBe(false)
  })

  it('every listed legal document exists in content/legal', () => {
    for (const path of LEGAL_SITEMAP_PATHS) {
      const slug = path.replace('/legal/', '')
      if (slug === 'sub-processors') continue // rendered from server/legal/subProcessors.ts
      expect(existsSync(join(__dirname, '..', '..', '..', 'content', 'legal', slug, 'en.md')), slug).toBe(true)
    }
  })

  it('localised marketing pages get one entry per language with every alternate + x-default', () => {
    const page = { paths: { en: '/markdown-to-pdf', de: '/de/markdown-to-pdf' }, defaultLanguage: 'en' }
    const entries = localisedEntries(BASE, page)
    expect(entries.map(e => e.loc)).toEqual([`${BASE}/markdown-to-pdf`, `${BASE}/de/markdown-to-pdf`])
    for (const entry of entries) {
      expect(entry.alternates).toEqual([
        { hreflang: 'en', href: `${BASE}/markdown-to-pdf` },
        { hreflang: 'de', href: `${BASE}/de/markdown-to-pdf` },
        { hreflang: 'x-default', href: `${BASE}/markdown-to-pdf` }
      ])
    }
  })
})

describe('marketingSitemapPages (marketing content collection)', () => {
  it('groups language versions per slug, leaves unreviewed translations out', () => {
    const pages = marketingSitemapPages([
      { path: '/marketing/de/markdown-to-pdf' },
      { path: '/marketing/en/markdown-to-pdf' },
      { path: '/marketing/fr/markdown-to-pdf', reviewed: false },
      { path: '/marketing/en/markdown-cheat-sheet', reviewed: null },
      { path: '/marketing/de/markdown-cheat-sheet', reviewed: false },
      { path: '/docs/not-marketing' }
    ])
    expect(pages).toEqual([
      { paths: { en: '/markdown-cheat-sheet' }, defaultLanguage: 'en' },
      { paths: { en: '/markdown-to-pdf', de: '/de/markdown-to-pdf' }, defaultLanguage: 'en' }
    ])
  })

  it('end to end: the sitemap lists reviewed versions with xhtml alternates only', () => {
    const xml = buildSitemapXml(sitemapEntries(BASE, {
      docsPaths: [],
      legalSurfaces: false,
      marketingPages: marketingSitemapPages([
        { path: '/marketing/en/markdown-to-pdf' },
        { path: '/marketing/de/markdown-to-pdf' },
        { path: '/marketing/fr/markdown-to-pdf', reviewed: false }
      ])
    }))
    expect(xml).toContain(`<loc>${BASE}/markdown-to-pdf</loc>`)
    expect(xml).toContain(`<loc>${BASE}/de/markdown-to-pdf</loc>`)
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="de" href="${BASE}/de/markdown-to-pdf"/>`)
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="x-default" href="${BASE}/markdown-to-pdf"/>`)
    expect(xml).not.toContain('/fr/markdown-to-pdf')
  })

  it('the committed content: the cheat sheet is listed, its unreviewed de stub is not', () => {
    const dir = join(__dirname, '..', '..', '..', 'content', 'marketing')
    const versions = ['en', 'de'].map((locale) => {
      const text = readFileSync(join(dir, locale, 'markdown-cheat-sheet.md'), 'utf8')
      const fm: unknown = parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')
      const reviewed = typeof fm === 'object' && fm !== null ? (fm as Record<string, unknown>).reviewed : undefined
      return { path: `/marketing/${locale}/markdown-cheat-sheet`, reviewed: typeof reviewed === 'boolean' ? reviewed : undefined }
    })
    expect(versions[1]?.reviewed).toBe(false)
    expect(marketingSitemapPages(versions)).toEqual([{ paths: { en: '/markdown-cheat-sheet' }, defaultLanguage: 'en' }])
  })
})

describe('buildSitemapXml', () => {
  it('renders a sitemaps.org urlset with xhtml alternates, XML-escaped', () => {
    const xml = buildSitemapXml([
      { loc: `${BASE}/a?x=1&y=2` },
      { loc: `${BASE}/de/b`, alternates: [{ hreflang: 'de', href: `${BASE}/de/b` }] }
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">')).toBe(true)
    expect(xml).toContain(`<loc>${BASE}/a?x=1&amp;y=2</loc>`)
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="de" href="${BASE}/de/b"/>`)
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true)
  })
})
