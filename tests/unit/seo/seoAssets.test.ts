import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OG_IMAGES } from '../../../shared/seo/ogImages'
import { buildSitemapXml, LEGAL_LASTMOD, LEGAL_SITEMAP_PATHS, marketingSitemapPages, sitemapEntries } from '../../../server/utils/platform/sitemap'
import { sampleHeadingsToDivs } from '../../../app/utils/marketing/sampleHeadings'
import { LEGAL_PAGE_DESCRIPTIONS, MAX_DESCRIPTION_LENGTH } from '../../../shared/seo/meta'

// SEO-7 assets and dates: the committed social cards are real 1200×630
// JPEGs, sitemap <lastmod> comes from frontmatter / legal effective
// dates, docs pages carry an `updated` date, and rendered samples on
// marketing pages contribute no headings to the page outline.

const ROOT = join(__dirname, '../../..')

/** Width × height from a baseline/progressive JPEG's SOF marker. */
function jpegSize(bytes: Buffer): { width: number, height: number } | null {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) return null
    const marker = bytes[i + 1] ?? 0
    const length = bytes.readUInt16BE(i + 2)
    if (marker >= 0xC0 && marker <= 0xC3) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + length
  }
  return null
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
}

describe('social cards on disk', () => {
  it.each(Object.entries(OG_IMAGES))('%s is a 1200×630 JPEG under 300 KB', (_group, card) => {
    const bytes = readFileSync(join(ROOT, 'public', card.path))
    expect(jpegSize(bytes)).toEqual({ width: 1200, height: 630 })
    expect(bytes.length).toBeLessThan(300 * 1024)
  })
})

describe('content dates', () => {
  it('every docs page has a valid `updated` date', () => {
    const files = walk(join(ROOT, 'content/docs')).filter(f => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
      const updated = /^updated:\s*'?(\d{4}-\d{2}-\d{2})'?\s*$/m.exec(front)?.[1]
      expect(updated, file).toBeDefined()
      expect(Number.isNaN(Date.parse(`${updated}T00:00:00Z`)), file).toBe(false)
    }
  })

  it('every marketing HowTo has at least two named steps', () => {
    const files = walk(join(ROOT, 'content/marketing')).filter(f => f.endsWith('.md'))
    for (const file of files) {
      const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
      if (!/^howTo:/m.test(front)) continue
      const steps = front.match(/^ {4}- name: \S.*$/gm) ?? []
      expect(steps.length, file).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('legal page descriptions', () => {
  it('cover every sitemap legal page and fit a search result', () => {
    for (const path of LEGAL_SITEMAP_PATHS) {
      const text = LEGAL_PAGE_DESCRIPTIONS[path.replace('/legal/', '')] ?? ''
      expect(text.length, path).toBeGreaterThan(50)
      expect(text.length, path).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    }
  })
})

describe('sitemap <lastmod>', () => {
  const BASE = 'https://markoto.app'

  it('uses docs + marketing `updated` and the legal effective dates', () => {
    const xml = buildSitemapXml(sitemapEntries(BASE, {
      docsPaths: ['/docs/a', '/docs/b'],
      docsLastmod: { '/docs/a': '2026-11-01', '/docs/b': 'not a date' },
      legalSurfaces: true,
      marketingPages: marketingSitemapPages([
        { path: '/marketing/en/markdown-to-pdf', reviewed: true, updated: '2026-11-04' },
        { path: '/marketing/de/markdown-to-pdf', reviewed: true, updated: null }
      ])
    }))
    expect(xml).toContain('<loc>https://markoto.app/docs/a</loc>\n    <lastmod>2026-11-01</lastmod>')
    expect(xml).toContain('<loc>https://markoto.app/docs/b</loc>\n  </url>')
    expect(xml).toContain('<loc>https://markoto.app/markdown-to-pdf</loc>\n    <lastmod>2026-11-04</lastmod>')
    expect(xml).toContain('<loc>https://markoto.app/de/markdown-to-pdf</loc>\n    <xhtml:link')
    for (const path of LEGAL_SITEMAP_PATHS) {
      expect(xml).toContain(`<loc>${BASE}${path}</loc>\n    <lastmod>${LEGAL_LASTMOD[path]}</lastmod>`)
    }
  })
})

describe('sampleHeadingsToDivs', () => {
  it('turns sample headings into styled divs, keeping their attributes', () => {
    const html = '<h1 id="report" tabindex="-1">Report</h1><h2 class="x">Sub</h2><header>keep</header><hr><pre><code>&lt;h1&gt;</code></pre>'
    const out = sampleHeadingsToDivs(html)
    expect(out).not.toMatch(/<h[1-6]/)
    expect(out).toContain('<div class="mk-sample-h mk-sample-h1" id="report" tabindex="-1">Report</div>')
    expect(out).toContain('<div class="mk-sample-h mk-sample-h2 x">Sub</div>')
    expect(out).toContain('<header>keep</header><hr>')
    expect(out).toContain('&lt;h1&gt;')
  })
})
