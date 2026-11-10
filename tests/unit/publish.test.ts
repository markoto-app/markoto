import { describe, expect, it } from 'vitest'
import { collectSnapshotAssets, rewriteSnapshotAssets } from '../../server/utils/publish/snapshotAssets'
import { buildPublishedPageHtml, cssForStyleElement, publishedHljsStylesheet, publishedPageCsp } from '../../server/utils/publish/pageHtml'
import { sweepPublishedOrphans } from '../../server/utils/publish/orphanSweep'
import { PUBLISH_SLUG_RE, slugFromTitle } from '../../shared/config/publish'
import { hljsTheme } from '../../shared/utils/hljsAssets'
import type { ObjectStore } from '../../server/utils/objectStore'

// Publish as a web page (WP13): the pure parts — which files a snapshot
// shows and how their URLs are rewritten, the page HTML and its CSP,
// slugs, the orphan sweep.

const DOC = 'docA1'
const PAGE = 'PageId0123456789'

describe('snapshot assets', () => {
  const html = `<img src="/api/files/${DOC}/abc.png" alt=""><img src="/api/files/otherDoc/zzz.png"><a href="https://evil.example/api/files/${DOC}/abc.png">x</a>`
  const css = `.c { background: url('/api/files/${DOC}/hdr.jpg'); } @font-face { src: url('/api/docs/${DOC}/brand/brand-font-00001.woff2') format('woff2'); }`

  it('finds this document\'s uploads and brand files, nothing else', () => {
    const refs = collectSnapshotAssets([html, css], DOC)
    expect([...refs.files].sort()).toEqual(['abc.png', 'hdr.jpg'])
    expect([...refs.brand]).toEqual(['brand-font-00001.woff2'])
  })

  it('rewrites only what was copied', () => {
    const copied = { files: new Set(['abc.png']), brand: new Set(['brand-font-00001.woff2']) }
    const outHtml = rewriteSnapshotAssets(html, DOC, PAGE, copied)
    expect(outHtml).toContain(`src="/api/published/${PAGE}/files/abc.png"`)
    expect(outHtml).toContain('/api/files/otherDoc/zzz.png')
    // A URL that merely contains the path (another host) is left alone.
    expect(outHtml).toContain(`https://evil.example/api/files/${DOC}/abc.png`)
    const outCss = rewriteSnapshotAssets(css, DOC, PAGE, copied)
    expect(outCss).toContain(`/api/files/${DOC}/hdr.jpg`)
    expect(outCss).toContain(`/api/published/${PAGE}/brand/brand-font-00001.woff2`)
  })

  it('treats the doc id literally', () => {
    expect(collectSnapshotAssets(['/api/files/docXA1/abc.png'], 'doc.A1').files.size).toBe(0)
  })
})

describe('published page HTML', () => {
  const base = {
    title: 'Q3 <report> & "notes"',
    language: 'de',
    html: '<h1>Q3</h1><p>Text</p>',
    css: '.paged-doc { --doc-bg: #faf8f4; color: red } </style><script>alert(1)</script>',
    fontsImport: '',
    hljsUrl: null,
    indexable: false,
    canonicalUrl: 'https://markoto.app/p/q3',
    reportUrl: 'https://markoto.app/legal/abuse?url=x'
  }

  it('escapes the title, keeps CSS inside its element, localises the footer', () => {
    const html = buildPublishedPageHtml(base)
    expect(html).toContain('<title>Q3 &lt;report&gt; &amp; &quot;notes&quot;</title>')
    expect(html).not.toContain('</style><script>')
    expect(html).toContain('<\\/style><script>')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('Veröffentlicht mit markoto')
    expect(html).toContain('html { background: #faf8f4; }')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).not.toContain('rel="canonical"')
  })

  it('indexable pages carry a canonical link', () => {
    expect(buildPublishedPageHtml({ ...base, indexable: true })).toContain('<link rel="canonical" href="https://markoto.app/p/q3">')
  })

  it('only our vendored highlight.js stylesheets, with SRI', () => {
    const url = hljsTheme('github-dark').url
    expect(publishedHljsStylesheet(url)).toEqual({ url, sri: hljsTheme('github-dark').sri })
    expect(publishedHljsStylesheet('https://cdn.example/x.css')).toBeNull()
    expect(publishedHljsStylesheet(`${url}?x`)).toBeNull()
    expect(buildPublishedPageHtml({ ...base, hljsUrl: 'https://cdn.example/x.css' })).not.toContain('cdn.example')
  })

  it('an odd language tag falls back to en', () => {
    expect(buildPublishedPageHtml({ ...base, language: '"><script>' })).toContain('<html lang="en">')
  })

  it('CSP: no script, own resources only, sandboxed', () => {
    const csp = publishedPageCsp()
    expect(csp).toContain(`default-src 'none'`)
    expect(csp).not.toMatch(/script-src/)
    expect(csp).toContain(`frame-ancestors 'none'`)
    expect(csp).toMatch(/sandbox [^;]*allow-same-origin/)
    expect(csp).not.toMatch(/allow-scripts|allow-forms/)
    expect(cssForStyleElement('a</STYLE>b<!--c')).toBe('a<\\/STYLE>b<\\!--c')
  })
})

describe('slugs', () => {
  it('from a title: folded, hyphenated, suffixed', () => {
    expect(slugFromTitle('Über die Brücke — Teil 2!', 'k3x9za')).toBe('uber-die-brucke-teil-2-k3x9za')
    expect(slugFromTitle('日本語', 'k3x9za')).toBe('page-k3x9za')
    expect(slugFromTitle('a'.repeat(80), 'k3x9za')).toHaveLength(48 + 7)
    for (const s of [slugFromTitle('Über die Brücke', 'k3x9za'), 'abc', 'a-b-c']) expect(PUBLISH_SLUG_RE.test(s), s).toBe(true)
    for (const s of ['ab', 'Abc', 'a--b', '-ab', 'ab-', 'a_b', 'a'.repeat(61)]) expect(PUBLISH_SLUG_RE.test(s), s).toBe(false)
  })
})

describe('published orphan sweep', () => {
  // `path` rather than `key`: gitleaks reads `key: '<path>'` as an API key.
  function store(objects: Array<{ path: string, ageMs: number }>, now: number) {
    const deleted: string[] = []
    const s: ObjectStore = {
      list: async prefix => objects.filter(o => o.path.startsWith(prefix)).map(o => ({ key: o.path, lastModified: new Date(now - o.ageMs) })),
      deleteMany: async (ks) => { deleted.push(...ks) }
    }
    return { s, deleted }
  }

  it('deletes old objects of pages that no longer exist, nothing else', async () => {
    const now = Date.now()
    const hour = 3_600_000
    const { s, deleted } = store([
      { path: 'published/LiveLiveLiveLive/files/a.png', ageMs: 5 * hour },
      { path: 'published/GoneGoneGoneGone/files/a.png', ageMs: 5 * hour },
      { path: 'published/GoneGoneGoneGone/brand/brand-font-00001.woff2', ageMs: 5 * hour },
      { path: 'published/NewNewNewNewNewN/files/a.png', ageMs: 10 * 60_000 },
      { path: 'published/weird/other', ageMs: 5 * hour }
    ], now)
    const out = await sweepPublishedOrphans({ store: s, livePageIds: async () => new Set(['LiveLiveLiveLive']), now })
    expect(out.deleted).toBe(2)
    expect(deleted.sort()).toEqual(['published/GoneGoneGoneGone/brand/brand-font-00001.woff2', 'published/GoneGoneGoneGone/files/a.png'])
  })
})
