import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  isLocalisedUiRoute,
  localisedPath,
  MARKETING_LOCALES,
  marketingUiRoutes,
  marketingUrlLocale,
  preferredMarketingLocale,
  REVIEWED_UI_LOCALES,
  splitMarketingLocale,
  uiPageOfRoute,
  uiPageVariants,
  variantAlternates
} from '../../../shared/seo/marketing'
import { canonicalUrl } from '../../../shared/seo/paths'

// One URL per language for the public marketing pages (shared/seo/marketing.ts):
// English at the root, the other UI languages under a prefix; the UI
// language follows the URL there and nowhere else.

describe('marketing languages = UI languages', () => {
  it('match the i18n locales of nuxt.config.ts, English first', () => {
    const config = readFileSync(join(__dirname, '..', '..', '..', 'nuxt.config.ts'), 'utf8')
    const i18n = config.slice(config.indexOf('i18n: {'))
    const codes = [...i18n.matchAll(/\{ code: '([a-z]+)'/g)].map(m => m[1])
    expect([...MARKETING_LOCALES]).toEqual(codes)
    expect(MARKETING_LOCALES[0]).toBe('en')
  })

  it('English is reviewed; every reviewed language is a UI language', () => {
    expect(REVIEWED_UI_LOCALES).toContain('en')
    for (const locale of REVIEWED_UI_LOCALES) expect(MARKETING_LOCALES).toContain(locale)
  })
})

describe('splitMarketingLocale + localisedPath', () => {
  it('splits a locale prefix off, bare prefix included', () => {
    expect(splitMarketingLocale('/de/pricing')).toEqual({ locale: 'de', path: '/pricing' })
    expect(splitMarketingLocale('/de')).toEqual({ locale: 'de', path: '/' })
    expect(splitMarketingLocale('/zh/compare/hackmd?x=1')).toEqual({ locale: 'zh', path: '/compare/hackmd' })
    expect(splitMarketingLocale('/pricing')).toEqual({ locale: 'en', path: '/pricing' })
    expect(splitMarketingLocale('/')).toEqual({ locale: 'en', path: '/' })
    // `/en/…` is not a prefix: English lives at the root.
    expect(splitMarketingLocale('/en/pricing')).toEqual({ locale: 'en', path: '/en/pricing' })
  })

  it('builds the URL of a page in a language', () => {
    expect(localisedPath('en', '/')).toBe('/')
    expect(localisedPath('en', '/pricing')).toBe('/pricing')
    expect(localisedPath('de', '/')).toBe('/de')
    expect(localisedPath('fr', '/pricing')).toBe('/fr/pricing')
    expect(localisedPath('ja', '/compare/hackmd')).toBe('/ja/compare/hackmd')
  })
})

describe('marketingUrlLocale (which routes take their language from the URL)', () => {
  const base = { marketingSite: true, signedIn: false }

  it('marketing pages: English unprefixed, their language prefixed', () => {
    expect(marketingUrlLocale({ ...base, routeName: 'pricing', path: '/pricing' })).toBe('en')
    expect(marketingUrlLocale({ ...base, routeName: 'pricing-de', path: '/de/pricing' })).toBe('de')
    expect(marketingUrlLocale({ ...base, routeName: 'index', path: '/' })).toBe('en')
    expect(marketingUrlLocale({ ...base, routeName: 'index-fr', path: '/fr' })).toBe('fr')
    expect(marketingUrlLocale({ ...base, routeName: 'demo-ja', path: '/ja/demo' })).toBe('ja')
    expect(marketingUrlLocale({ ...base, routeName: 'marketing', path: '/markdown-to-pdf' })).toBe('en')
    expect(marketingUrlLocale({ ...base, routeName: 'marketing', path: '/de/markdown-to-pdf' })).toBe('de')
  })

  it('the app, docs and legal pages keep the visitor\'s language', () => {
    for (const [routeName, path] of [['d-id', '/d/abc'], ['w-id', '/w/x'], ['settings-profile', '/settings/profile'], ['docs-slug', '/docs/x'], ['legal-slug', '/legal/privacy'], ['admin', '/admin']]) {
      expect(marketingUrlLocale({ ...base, routeName, path }), path).toBeNull()
    }
  })

  it('signed in, `/` is the dashboard (the app); other marketing pages still follow the URL', () => {
    expect(marketingUrlLocale({ marketingSite: true, signedIn: true, routeName: 'index', path: '/' })).toBeNull()
    expect(marketingUrlLocale({ marketingSite: true, signedIn: true, routeName: 'pricing', path: '/pricing' })).toBe('en')
  })

  it('nothing off the marketing site (self-hosted keeps cookie / Accept-Language everywhere)', () => {
    expect(marketingUrlLocale({ marketingSite: false, signedIn: false, routeName: 'pricing', path: '/pricing' })).toBeNull()
    expect(marketingUrlLocale({ marketingSite: false, signedIn: false, routeName: 'index', path: '/' })).toBeNull()
  })
})

describe('marketingUiRoutes (pages:extend)', () => {
  const pages = [
    { name: 'index', path: '/', file: 'app/pages/index.vue', alias: ['/f/:folderId'] },
    { name: 'pricing', path: '/pricing', file: 'app/pages/pricing.vue' },
    { name: 'demo', path: '/demo', file: 'app/pages/demo.vue' },
    { name: 'd-id', path: '/d/:id()', file: 'app/pages/d/[id].vue' }
  ]

  it('adds one copy per prefixed language of the UI pages only, without aliases', () => {
    const routes = marketingUiRoutes(pages)
    expect(routes).toHaveLength(15)
    expect(routes.map(r => r.path)).toContain('/de')
    expect(routes.map(r => r.path)).toContain('/zh/pricing')
    expect(routes.map(r => r.path)).toContain('/es/demo')
    expect(routes.find(r => r.path === '/de')).toEqual({ name: 'index-de', path: '/de', file: 'app/pages/index.vue' })
    expect(routes.some(r => r.file === 'app/pages/d/[id].vue')).toBe(false)
  })

  it('names the copies so the URL rules recognise them', () => {
    for (const route of marketingUiRoutes(pages)) {
      expect(isLocalisedUiRoute(route.name), route.name).toBe(true)
      expect(uiPageOfRoute(route.name)).toBe(splitMarketingLocale(route.path).path)
    }
    expect(isLocalisedUiRoute('pricing')).toBe(false)
    expect(isLocalisedUiRoute('marketing')).toBe(false)
    expect(uiPageOfRoute('settings-profile')).toBeNull()
  })
})

describe('language versions, hreflang and canonicals of the UI pages', () => {
  it('every UI language has a version; only reviewed ones are indexable', () => {
    const variants = uiPageVariants('/pricing')
    expect(variants.map(v => v.path)).toEqual(['/pricing', '/de/pricing', '/fr/pricing', '/es/pricing', '/ja/pricing', '/zh/pricing'])
    for (const v of variants) expect(v.indexable).toBe(REVIEWED_UI_LOCALES.includes(v.locale))
  })

  it('hreflang lists the reviewed versions + x-default; an unreviewed version lists none', () => {
    const variants = uiPageVariants('/')
    const alternates = variantAlternates(variants, 'en')
    expect(alternates.at(-1)).toEqual({ hreflang: 'x-default', path: '/' })
    expect(alternates.map(a => a.hreflang).slice(0, -1)).toEqual([...REVIEWED_UI_LOCALES])
    for (const locale of MARKETING_LOCALES.filter(l => !REVIEWED_UI_LOCALES.includes(l))) {
      expect(variantAlternates(variants, locale), locale).toEqual([])
    }
  })

  it('with a reviewed translation both versions list each other', () => {
    const variants = [
      { locale: 'en' as const, path: '/pricing', indexable: true },
      { locale: 'de' as const, path: '/de/pricing', indexable: true },
      { locale: 'fr' as const, path: '/fr/pricing', indexable: false }
    ]
    const expected = [
      { hreflang: 'en', path: '/pricing' },
      { hreflang: 'de', path: '/de/pricing' },
      { hreflang: 'x-default', path: '/pricing' }
    ]
    expect(variantAlternates(variants, 'en')).toEqual(expected)
    expect(variantAlternates(variants, 'de')).toEqual(expected)
  })

  it('canonicals are self-referencing per language', () => {
    const origins = { siteUrl: 'https://markoto.app', docsCanonicalBase: '' }
    expect(canonicalUrl('/de/pricing', origins)).toBe('https://markoto.app/de/pricing')
    expect(canonicalUrl('/de', origins)).toBe('https://markoto.app/de')
    expect(canonicalUrl('/pricing?x=1', origins)).toBe('https://markoto.app/pricing')
    expect(canonicalUrl('/fr/markdown-to-pdf', origins)).toBe('https://markoto.app/fr/markdown-to-pdf')
  })
})

describe('preferredMarketingLocale (language suggestion)', () => {
  it('the locale cookie first, then the browser languages, primary subtag', () => {
    expect(preferredMarketingLocale('de', ['fr-FR'])).toBe('de')
    expect(preferredMarketingLocale(null, ['it-IT', 'de-CH', 'en'])).toBe('de')
    expect(preferredMarketingLocale('xx', ['zh-CN'])).toBe('zh')
    expect(preferredMarketingLocale(undefined, ['it', 'pt'])).toBeNull()
  })
})
