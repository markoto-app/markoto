import { describe, it, expect } from 'vitest'
import {
  homeStructuredData,
  isoDate,
  pageStructuredData,
  pricingStructuredData,
  type PageGraphInput
} from '../../../shared/seo/structuredData'
import { docsBreadcrumbs, hubBreadcrumbs, pageBreadcrumbs, slugLabel } from '../../../shared/seo/breadcrumbs'
import { OG_IMAGES, ogImageForPath } from '../../../shared/seo/ogImages'
import { ogLocale } from '../../../shared/seo/meta'

// JSON-LD of every public page type (SEO-7): one @graph per page whose
// nodes link by @id. Checked here: required fields per type, every
// reference resolves inside the graph, no @id defined twice, absolute
// https URLs, and never a rating or a review.

const SITE = 'https://markoto.app'
const OPERATOR = 'LatentSpace Labs GmbH'

type Node = Record<string, unknown>

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function graphOf(doc: Record<string, unknown>): Node[] {
  expect(doc['@context']).toBe('https://schema.org')
  const graph = doc['@graph']
  expect(Array.isArray(graph)).toBe(true)
  return Array.isArray(graph) ? graph.filter(isNode) : []
}

/** Walks every object; returns `@id` definitions (typed nodes) and bare references. */
function collect(value: unknown, defs: string[], refs: string[], urls: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, defs, refs, urls)
    return
  }
  if (!isNode(value)) return
  const id = value['@id']
  if (typeof id === 'string') {
    if (Object.keys(value).length === 1) refs.push(id)
    else defs.push(id)
  }
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'url' || k === 'item' || k === 'image' || k === '@id') && typeof v === 'string') urls.push(v)
    collect(v, defs, refs, urls)
  }
}

const REQUIRED: Record<string, string[]> = {
  Organization: ['name', 'url'],
  WebSite: ['name', 'url'],
  WebPage: ['url', 'name', 'description', 'inLanguage', 'isPartOf', 'breadcrumb'],
  CollectionPage: ['url', 'name', 'description', 'inLanguage', 'isPartOf', 'breadcrumb', 'mainEntity'],
  BreadcrumbList: ['itemListElement'],
  TechArticle: ['headline', 'description', 'mainEntityOfPage', 'publisher', 'author'],
  Article: ['headline', 'description', 'mainEntityOfPage', 'publisher', 'author', 'about'],
  HowTo: ['name', 'step'],
  ItemList: ['itemListElement'],
  SoftwareApplication: ['name']
}

/** Every structural rule; returns the graph's nodes by type for further checks. */
function validate(doc: Record<string, unknown>): Map<string, Node[]> {
  const graph = graphOf(doc)
  const byType = new Map<string, Node[]>()
  for (const node of graph) {
    const type = node['@type']
    expect(typeof type).toBe('string')
    if (typeof type !== 'string') continue
    byType.set(type, [...(byType.get(type) ?? []), node])
    for (const field of REQUIRED[type] ?? []) expect(node[field], `${type}.${field}`).toBeDefined()
  }
  const defs: string[] = []
  const refs: string[] = []
  const urls: string[] = []
  collect(graph, defs, refs, urls)
  expect(new Set(defs).size, `duplicate @id in ${defs.join(', ')}`).toBe(defs.length)
  for (const ref of refs) expect(defs, `unresolved reference ${ref}`).toContain(ref)
  for (const url of urls) {
    expect(() => new URL(url)).not.toThrow()
    expect(url.startsWith(`${SITE}/`)).toBe(true)
  }
  for (const list of byType.get('BreadcrumbList') ?? []) {
    const items = list.itemListElement
    expect(Array.isArray(items)).toBe(true)
    if (!Array.isArray(items)) continue
    items.forEach((item: unknown, i: number) => {
      expect(isNode(item) && item.position).toBe(i + 1)
      expect(isNode(item) && typeof item.name === 'string' && item.name.length > 0).toBe(true)
    })
  }
  expect(JSON.stringify(doc)).not.toMatch(/aggregateRating|"review/i)
  return byType
}

const base = (over: Partial<PageGraphInput>): PageGraphInput => ({
  siteUrl: SITE,
  path: '/x',
  name: 'A page',
  description: 'What the page is about.',
  inLanguage: 'en-US',
  breadcrumbs: pageBreadcrumbs('/x', 'A page'),
  operatorName: OPERATOR,
  image: `${SITE}/og/markoto.jpg`,
  ...over
})

describe('pageStructuredData per page type', () => {
  it('docs page: TechArticle + BreadcrumbList Home › Docs › section › page', () => {
    const doc = pageStructuredData(base({
      path: '/docs/writing/rich-content',
      name: 'Tables, alerts, math, and diagrams',
      dateModified: '2026-11-04',
      article: 'TechArticle',
      about: [{ self: true }],
      breadcrumbs: docsBreadcrumbs('/docs/writing/rich-content', 'Tables, alerts, math, and diagrams')
    }))
    const byType = validate(doc)
    const article = byType.get('TechArticle')?.[0]
    expect(article?.headline).toBe('Tables, alerts, math, and diagrams')
    expect(article?.dateModified).toBe('2026-11-04')
    expect(article?.mainEntityOfPage).toEqual({ '@id': `${SITE}/docs/writing/rich-content#webpage` })
    const crumbs = byType.get('BreadcrumbList')?.[0]?.itemListElement
    expect(JSON.stringify(crumbs)).toContain(`"name":"Writing","item":"${SITE}/docs/writing"`)
    expect(byType.get('WebPage')?.[0]?.mainEntity).toEqual({ '@id': `${SITE}/docs/writing/rich-content#article` })
  })

  it('use-case page: WebPage about the home page\'s app, HowTo only when given', () => {
    const plain = validate(pageStructuredData(base({ path: '/online-markdown-editor', about: [{ self: true }] })))
    expect(plain.get('WebPage')?.[0]?.about).toEqual([{ '@id': `${SITE}/#app` }])
    expect(plain.has('HowTo')).toBe(false)

    const howTo = validate(pageStructuredData(base({
      path: '/markdown-to-pdf',
      about: [{ self: true }],
      howTo: { name: 'Convert', steps: [{ name: 'Paste', text: 'Paste it.' }, { name: 'Download', text: 'Press it.' }] }
    })))
    const steps = howTo.get('HowTo')?.[0]?.step
    expect(Array.isArray(steps) && steps.length).toBe(2)
    expect(JSON.stringify(steps)).toContain('"@type":"HowToStep","position":2,"name":"Download"')
  })

  it('comparison page: Article about markoto and the other product, under the hub', () => {
    const byType = validate(pageStructuredData(base({
      path: '/compare/hackmd',
      article: 'Article',
      about: [{ self: true }, { name: 'HackMD' }],
      breadcrumbs: hubBreadcrumbs({ name: 'Compare', path: '/compare' }, '/compare/hackmd', 'markoto vs HackMD')
    })))
    const apps = byType.get('SoftwareApplication') ?? []
    expect(apps.map(a => a.name).sort()).toEqual(['HackMD', 'markoto'])
    expect(byType.get('Article')?.[0]?.about).toEqual([{ '@id': `${SITE}/#app` }, { '@id': `${SITE}/compare/hackmd#about-2` }])
    expect(byType.get('BreadcrumbList')?.[0]?.itemListElement).toHaveLength(3)
  })

  it('comparison hub: CollectionPage whose main entity is the ItemList', () => {
    const byType = validate(pageStructuredData(base({
      path: '/compare',
      pageType: 'CollectionPage',
      itemList: [{ name: 'markoto vs HackMD', path: '/compare/hackmd' }, { name: 'markoto vs HedgeDoc', path: '/compare/hedgedoc' }]
    })))
    expect(byType.get('CollectionPage')?.[0]?.mainEntity).toEqual({ '@id': `${SITE}/compare#itemlist` })
    expect(JSON.stringify(byType.get('ItemList'))).toContain(`"position":2,"name":"markoto vs HedgeDoc","url":"${SITE}/compare/hedgedoc"`)
  })

  it('pricing: one graph with the full SoftwareApplication, defined once', () => {
    const app = pricingStructuredData({ siteUrl: SITE, description: 'Plans.', inLanguage: 'en-US', currency: 'USD', offers: [{ name: 'Free account', price: 0 }] })
    const byType = validate(pageStructuredData(base({ path: '/pricing', about: [{ self: true }], extraNodes: [app] })))
    expect(byType.get('SoftwareApplication')).toHaveLength(1)
    expect(byType.get('SoftwareApplication')?.[0]?.offers).toBeDefined()
  })

  it('legal page: WebPage with the effective date, no article', () => {
    const byType = validate(pageStructuredData(base({ path: '/legal/privacy', dateModified: '2026-11-03' })))
    expect(byType.get('WebPage')?.[0]?.dateModified).toBe('2026-11-03')
    expect(byType.has('Article')).toBe(false)
  })

  it('without an operator: no Organization, no publisher, nothing dangling', () => {
    const doc = pageStructuredData(base({ operatorName: '', article: 'TechArticle', about: [{ self: true }] }))
    const graph = graphOf(doc)
    expect(graph.some(n => n['@type'] === 'Organization')).toBe(false)
    expect(JSON.stringify(doc)).not.toContain('publisher')
  })

  it('drops an invalid date and caps the headline at 110 characters', () => {
    const doc = pageStructuredData(base({ name: 'x'.repeat(130), dateModified: '2026-13-45', article: 'Article', about: [{ self: true }] }))
    const article = graphOf(doc).find(n => n['@type'] === 'Article')
    expect(article?.dateModified).toBeUndefined()
    expect(String(article?.headline)).toHaveLength(110)
  })

  it('home page graph keeps the site-wide ids the pages reference', () => {
    const text = JSON.stringify(homeStructuredData({ siteUrl: SITE, operatorName: OPERATOR, description: 'd', inLanguage: 'en-US' }))
    for (const id of ['/#organization', '/#website', '/#app']) expect(text).toContain(`"@id":"${SITE}${id}"`)
  })
})

describe('isoDate', () => {
  it('accepts real YYYY-MM-DD days only', () => {
    expect(isoDate('2026-11-04')).toBe('2026-11-04')
    expect(isoDate('2026-02-30T00:00')).toBeUndefined()
    expect(isoDate('04.11.2026')).toBeUndefined()
    expect(isoDate(null)).toBeUndefined()
  })
})

describe('breadcrumbs', () => {
  it('docs trails', () => {
    expect(docsBreadcrumbs('/docs', 'Documentation')).toEqual([{ name: 'Home', path: '/' }, { name: 'Documentation', path: '/docs' }])
    expect(docsBreadcrumbs('/docs/getting-started/', 'Getting started guide').map(c => c.path)).toEqual(['/', '/docs', '/docs/getting-started'])
    expect(slugLabel('import-export')).toBe('Import export')
  })
  it('page trails drop query and trailing slash', () => {
    expect(pageBreadcrumbs('/pricing/?a=1', 'Pricing')).toEqual([{ name: 'Home', path: '/' }, { name: 'Pricing', path: '/pricing' }])
  })
})

describe('social cards', () => {
  it('maps each page group to its 1200×630 card', () => {
    expect(ogImageForPath('/pricing')).toBe(OG_IMAGES.pricing)
    expect(ogImageForPath('/docs/writing/comments')).toBe(OG_IMAGES.docs)
    expect(ogImageForPath('/compare/hackmd')).toBe(OG_IMAGES.compare)
    expect(ogImageForPath('/de/compare')).toBe(OG_IMAGES.compare)
    expect(ogImageForPath('/markdown-to-pdf', { marketingPage: true })).toBe(OG_IMAGES.useCases)
    expect(ogImageForPath('/')).toBe(OG_IMAGES.default)
    for (const card of Object.values(OG_IMAGES)) {
      expect(card.width).toBe(1200)
      expect(card.height).toBe(630)
      expect(card.path).toMatch(/^\/og\/[a-z-]+\.jpg$/)
      expect(card.alt.length).toBeGreaterThan(10)
    }
  })
  it('og:locale', () => {
    expect(ogLocale('en-US')).toBe('en_US')
    expect(ogLocale('de')).toBe('')
  })
})
