import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  hreflangLinks,
  isIndexableVersion,
  marketingContentPath,
  marketingRoutePath,
  parseMarketingContentPath,
  parseMarketingRoute,
  prefixedMarketingLocale,
  PREFIXED_MARKETING_LOCALES,
  selfHostPath
} from '../../../shared/seo/marketing'
import { flowStripData, stripCaption } from '../../../shared/docs/flowStrip'
import { faqStructuredData, serializeJsonLd } from '../../../shared/seo/structuredData'

// Marketing pages (shared/seo/marketing.ts): English at the root, de/fr
// under a prefix; hreflang + indexing only for reviewed versions.

describe('parseMarketingRoute', () => {
  it('maps root paths to English and prefixed paths to their language', () => {
    expect(parseMarketingRoute('/markdown-cheat-sheet')).toEqual({ locale: 'en', slug: 'markdown-cheat-sheet' })
    expect(parseMarketingRoute('/de/markdown-cheat-sheet')).toEqual({ locale: 'de', slug: 'markdown-cheat-sheet' })
    expect(parseMarketingRoute('/fr/compare/hackmd/')).toEqual({ locale: 'fr', slug: 'compare/hackmd' })
    expect(parseMarketingRoute('/markdown-cheat-sheet?utm=x')).toEqual({ locale: 'en', slug: 'markdown-cheat-sheet' })
  })

  it('rejects what can never be a marketing page', () => {
    expect(parseMarketingRoute('/')).toBeNull()
    expect(parseMarketingRoute('/de')).toBeNull()
    expect(parseMarketingRoute('/de/')).toBeNull()
    expect(parseMarketingRoute('/Upper-Case')).toBeNull()
    expect(parseMarketingRoute('/a/../b')).toBeNull()
    expect(parseMarketingRoute('/with%20space')).toBeNull()
    expect(parseMarketingRoute('/trailing-')).toBeNull()
  })

  it('/en/… is not a prefix (English lives at the root)', () => {
    expect(parseMarketingRoute('/en/markdown-cheat-sheet')).toEqual({ locale: 'en', slug: 'en/markdown-cheat-sheet' })
  })
})

describe('prefixedMarketingLocale (UI language from the URL)', () => {
  it('names de / fr for prefixed marketing paths only', () => {
    expect(prefixedMarketingLocale('/de/markdown-cheat-sheet')).toBe('de')
    expect(prefixedMarketingLocale('/fr/markdown-cheat-sheet?x=1')).toBe('fr')
    expect(prefixedMarketingLocale('/markdown-cheat-sheet')).toBeNull()
    expect(prefixedMarketingLocale('/de')).toBeNull()
    expect(prefixedMarketingLocale('/docs/de/x')).toBeNull()
    expect(prefixedMarketingLocale('/d/abc')).toBeNull()
    expect(prefixedMarketingLocale('/es/markdown-cheat-sheet')).toBeNull()
  })
})

describe('content ↔ route paths', () => {
  it('round-trips', () => {
    expect(marketingContentPath('de', 'markdown-cheat-sheet')).toBe('/marketing/de/markdown-cheat-sheet')
    expect(marketingRoutePath('en', 'markdown-cheat-sheet')).toBe('/markdown-cheat-sheet')
    expect(marketingRoutePath('fr', 'markdown-cheat-sheet')).toBe('/fr/markdown-cheat-sheet')
    expect(parseMarketingContentPath('/marketing/fr/x-y')).toEqual({ locale: 'fr', slug: 'x-y' })
    expect(parseMarketingContentPath('/marketing/es/x')).toBeNull()
    expect(parseMarketingContentPath('/docs/en/x')).toBeNull()
  })

  it('handles nested slugs and section index pages (/compare, /compare/hackmd)', () => {
    // content/marketing/en/compare/index.md → content path /marketing/en/compare
    expect(parseMarketingContentPath('/marketing/en/compare')).toEqual({ locale: 'en', slug: 'compare' })
    expect(parseMarketingContentPath('/marketing/en/compare/hackmd')).toEqual({ locale: 'en', slug: 'compare/hackmd' })
    expect(parseMarketingRoute('/compare/google-docs')).toEqual({ locale: 'en', slug: 'compare/google-docs' })
    expect(marketingRoutePath('en', 'compare/hackmd')).toBe('/compare/hackmd')
    expect(marketingContentPath('en', 'compare/hackmd')).toBe('/marketing/en/compare/hackmd')
  })
})

describe('indexing + hreflang', () => {
  it('only `reviewed: false` makes a version noindex', () => {
    expect(isIndexableVersion({})).toBe(true)
    expect(isIndexableVersion({ reviewed: null })).toBe(true)
    expect(isIndexableVersion({ reviewed: true })).toBe(true)
    expect(isIndexableVersion({ reviewed: false })).toBe(false)
  })

  it('lists the existing reviewed versions in a fixed order, plus x-default → English', () => {
    expect(hreflangLinks('markdown-to-pdf', [
      { path: '/marketing/fr/markdown-to-pdf' },
      { path: '/marketing/en/markdown-to-pdf' },
      { path: '/marketing/de/markdown-to-pdf' },
      { path: '/marketing/de/other-page' }
    ])).toEqual([
      { hreflang: 'en', path: '/markdown-to-pdf' },
      { hreflang: 'de', path: '/de/markdown-to-pdf' },
      { hreflang: 'fr', path: '/fr/markdown-to-pdf' },
      { hreflang: 'x-default', path: '/markdown-to-pdf' }
    ])
  })

  it('leaves out languages without a file and unreviewed translations', () => {
    expect(hreflangLinks('markdown-cheat-sheet', [
      { path: '/marketing/en/markdown-cheat-sheet' },
      { path: '/marketing/de/markdown-cheat-sheet', reviewed: false }
    ])).toEqual([
      { hreflang: 'en', path: '/markdown-cheat-sheet' },
      { hreflang: 'x-default', path: '/markdown-cheat-sheet' }
    ])
  })

  it('no x-default without an English version', () => {
    expect(hreflangLinks('eu-only', [{ path: '/marketing/de/eu-only' }])).toEqual([
      { hreflang: 'de', path: '/de/eu-only' }
    ])
  })
})

describe('flowStripData (::flow-strip)', () => {
  const manifest = {
    viewport: { w: 1280, h: 800 },
    entries: [
      { kind: 'chapter', text: 'Intro' },
      { kind: 'narration', file: '01.webp', text: 'Plain markdown.' },
      { kind: 'outcome', file: '05.webp', caption: 'A code block lands.' },
      { kind: 'outcome', file: '10.webp', caption: 'A tip lands.' },
      { kind: 'outcome', file: '15.webp', caption: 'An equation lands.' },
      { kind: 'narration', file: '20.webp', text: 'Every insert shows up.' },
      { kind: 'outcome', file: '20.webp', caption: 'All rendered.', hero: true },
      { kind: 'outcome', file: '../evil.webp', caption: 'nope' }
    ]
  }

  it('picks the requested shots, outcome captions first', () => {
    expect(flowStripData(manifest, '20, 5')).toEqual({
      width: 1280,
      height: 800,
      frames: [
        { file: '20.webp', caption: 'All rendered.' },
        { file: '05.webp', caption: 'A code block lands.' }
      ]
    })
  })

  it('defaults to the hero plus the outcomes before it, in flow order', () => {
    expect(flowStripData(manifest, undefined, 3)?.frames.map(f => f.file)).toEqual(['10.webp', '15.webp', '20.webp'])
    expect(flowStripData(manifest, undefined, 1)?.frames.map(f => f.file)).toEqual(['20.webp'])
  })

  it('rejects malformed manifests and unsafe file names', () => {
    expect(flowStripData(null, undefined)).toBeNull()
    expect(flowStripData({ viewport: { w: 0, h: 1 }, entries: [] }, undefined)).toBeNull()
    expect(flowStripData(manifest, '99')?.frames).toEqual([])
  })
})

describe('stripCaption (::flow-strip captions)', () => {
  it('the page\'s own captions win, one per shot in order', () => {
    const captions = ['Two writers.', 'A comment arrives.']
    expect(stripCaption('On YOUR screen: …', 0, 2, { captions })).toBe('Two writers.')
    expect(stripCaption('On YOUR screen: …', 1, 2, { captions })).toBe('A comment arrives.')
  })

  it('falls back to the step text for missing, blank or non-string entries', () => {
    expect(stripCaption('Step text.', 2, 3, { captions: ['a', 'b'] })).toBe('Step text.')
    expect(stripCaption('Step text.', 0, 2, { captions: ['  '] })).toBe('Step text.')
    expect(stripCaption('Step text.', 0, 2, { captions: [42] })).toBe('Step text.')
  })

  it('a single `caption` covers only a one-shot strip, and `captions` beats it', () => {
    expect(stripCaption('Step text.', 0, 1, { caption: 'Mine.' })).toBe('Mine.')
    expect(stripCaption('Step text.', 0, 2, { caption: 'Mine.' })).toBe('Step text.')
    expect(stripCaption('Step text.', 0, 1, { caption: 'Mine.', captions: ['Listed.'] })).toBe('Listed.')
  })
})

describe('faqStructuredData (::faq json-ld)', () => {
  it('builds a FAQPage and escapes <', () => {
    const json = serializeJsonLd(faqStructuredData([{ q: 'Is it free?', a: 'Yes. </script>' }], 'en-US'))
    expect(json).not.toContain('</script>')
    expect(JSON.parse(json)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'inLanguage': 'en-US',
      'mainEntity': [{ '@type': 'Question', 'name': 'Is it free?', 'acceptedAnswer': { '@type': 'Answer', 'text': 'Yes. </script>' } }]
    })
  })
})

describe('selfHostPath (header + footer "Self-host")', () => {
  it('is the marketing page on the marketing site and the install guide everywhere else', () => {
    expect(selfHostPath(true)).toBe('/self-hosted-markdown-editor')
    expect(selfHostPath(false)).toBe('/docs/getting-started/self-hosting')
  })

  it('both targets exist, and the page stays out of the Use cases menu (it would be listed twice)', () => {
    const page = readFileSync(resolve(__dirname, '../../../content/marketing/en/self-hosted-markdown-editor.md'), 'utf8')
    expect(page).not.toMatch(/^navGroup:/m)
    expect(existsSync(resolve(__dirname, '../../../content/docs/getting-started/self-hosting.md'))).toBe(true)
  })
})

// Translations (content/marketing/de|fr): every page translates an
// English one block for block, links to the localised versions that
// exist, and German writes Swiss "ss" (never "ß").
describe('translated marketing pages', () => {
  const root = resolve(__dirname, '../../../content/marketing')

  function pages(dir: string, prefix = ''): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) return pages(full, `${prefix}${name}/`)
      return name.endsWith('.md') ? [`${prefix}${name}`] : []
    })
  }

  /** MDC block names in document order (`::try-it{…}` → `try-it`; closing `::` lines skipped). */
  function blocks(text: string): string[] {
    return [...text.matchAll(/^::([a-z][a-z-]*)/gm)].map(m => m[1] ?? '')
  }

  function frontmatterText(text: string): string {
    return /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  }

  const translated = PREFIXED_MARKETING_LOCALES.flatMap(locale =>
    existsSync(join(root, locale)) ? pages(join(root, locale)).map(file => ({ locale, file })) : []
  )

  it('finds the de and fr pages', () => {
    for (const locale of PREFIXED_MARKETING_LOCALES) {
      expect(translated.filter(t => t.locale === locale).length, locale).toBeGreaterThan(0)
    }
  })

  for (const { locale, file } of translated) {
    const rel = `${locale}/${file}`
    const text = readFileSync(join(root, locale, file), 'utf8')

    it(`${rel}: has an English original with the same blocks in the same order`, () => {
      const enFile = join(root, 'en', file)
      expect(existsSync(enFile), `content/marketing/en/${file}`).toBe(true)
      const en = blocks(readFileSync(enFile, 'utf8'))
      expect(blocks(text)).toEqual(en)
      for (const name of ['try-it', 'faq', 'cta']) {
        expect(blocks(text).filter(b => b === name).length, `::${name}`).toBe(en.filter(b => b === name).length)
      }
    })

    it(`${rel}: says whether a native speaker has reviewed it`, () => {
      expect(frontmatterText(text)).toMatch(/^reviewed: (true|false)$/m)
    })

    it(`${rel}: links to the ${locale} version of pages that have one`, () => {
      for (const match of text.matchAll(/\]\((\/[a-z0-9/-]+)\)/g)) {
        const target = parseMarketingRoute(match[1] ?? '')
        if (!target || target.locale !== 'en') continue
        const localised = join(root, locale, `${target.slug}.md`)
        expect(existsSync(localised), `${match[1]} → /${locale}/${target.slug}`).toBe(false)
      }
    })

    if (locale === 'de') {
      it(`${rel}: writes "ss", never "ß"`, () => {
        expect(text).not.toContain('ß')
      })
    }
  }

  it('the German UI strings write "ss", never "ß"', () => {
    expect(readFileSync(resolve(__dirname, '../../../i18n/locales/de.json'), 'utf8')).not.toContain('ß')
  })
})
