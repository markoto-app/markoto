// schema.org JSON-LD for the public pages of the hosted site
// (markoto.app): the home page, pricing, marketing content pages, the
// comparison hub + pages, docs and legal pages. Every page below `/` gets
// ONE `@graph` with a WebPage (or subtype), its BreadcrumbList and the
// page's main entity; nodes link by `@id`, and the site-wide ids
// (`/#organization`, `/#website`, `/#app`) are the home page's.
//
// Only facts we can stand behind: the operating entity (from the legal
// entity resolver, `shared/legal/entity.ts`, shipped to the client as
// `InstanceConfig.operatorName`), the site, and the free web app. No
// aggregateRating / reviews — there are none, and inventing them is
// against both Google's rules and ours.

import { SITE_NAME } from './meta'

export interface HomeStructuredDataInput {
  /** Public origin, e.g. `https://markoto.app` (no trailing slash). */
  siteUrl: string
  /** Operating entity, e.g. "LatentSpace Labs GmbH"; '' = leave Organization out. */
  operatorName: string
  /** Page description (the same sentence as the meta description). */
  description: string
  /** BCP 47 tag of the page's language. */
  inLanguage: string
}

/** One `@graph` document with Organization, WebSite and SoftwareApplication. */
export function homeStructuredData(input: HomeStructuredDataInput): Record<string, unknown> {
  const home = `${input.siteUrl}/`
  const orgId = siteIds(input.siteUrl).organization
  const graph: Record<string, unknown>[] = []
  if (input.operatorName) {
    graph.push({
      '@type': 'Organization',
      '@id': orgId,
      'name': input.operatorName,
      'url': home,
      'logo': `${input.siteUrl}/apple-touch-icon.png`
    })
  }
  const publisher = input.operatorName ? { publisher: { '@id': orgId } } : {}
  graph.push({
    '@type': 'WebSite',
    '@id': `${home}#website`,
    'name': SITE_NAME,
    'url': home,
    'inLanguage': input.inLanguage,
    ...publisher
  })
  graph.push({
    '@type': 'SoftwareApplication',
    '@id': `${home}#app`,
    'name': SITE_NAME,
    'url': home,
    'description': input.description,
    'applicationCategory': 'BusinessApplication',
    'operatingSystem': 'Web',
    'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'USD' },
    ...publisher
  })
  return { '@context': 'https://schema.org', '@graph': graph }
}

export interface PricingOffer {
  /** Offer name, e.g. "Free account", "Pro". */
  name: string
  /** Monthly price in `currency`. */
  price: number
}

export interface PricingStructuredDataInput {
  /** Public origin, e.g. `https://markoto.app` (no trailing slash). */
  siteUrl: string
  /** Page description (the same sentence as the meta description). */
  description: string
  inLanguage: string
  /** ISO 4217 code of every price. */
  currency: string
  /** Offers someone can take up TODAY. Never planned prices. */
  offers: PricingOffer[]
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2)
}

/**
 * SoftwareApplication with one Offer per plan that can be taken up now,
 * for /pricing on the marketing site. Same `@id` as the home page's
 * node, so consumers merge the two. Paid offers carry a monthly
 * UnitPriceSpecification. Callers pass only purchasable offers: while
 * paid plans are "coming soon" that is the free account alone, because
 * an Offer states a price someone can pay, and a planned price can't be
 * paid yet.
 */
export function pricingStructuredData(input: PricingStructuredDataInput): Record<string, unknown> {
  const home = `${input.siteUrl}/`
  const url = `${input.siteUrl}/pricing`
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${home}#app`,
    'name': SITE_NAME,
    'url': home,
    'description': input.description,
    'inLanguage': input.inLanguage,
    'applicationCategory': 'BusinessApplication',
    'operatingSystem': 'Web',
    'offers': input.offers.map((offer) => {
      const price = formatPrice(offer.price)
      const base = { '@type': 'Offer', 'name': offer.name, 'price': price, 'priceCurrency': input.currency, 'url': url }
      if (offer.price === 0) return base
      return {
        ...base,
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          'price': price,
          'priceCurrency': input.currency,
          'billingDuration': 'P1M',
          'unitText': 'MONTH'
        }
      }
    })
  }
}

/**
 * JSON for an inline `<script type="application/ld+json">`. `<` is
 * escaped so no value can close the script element early.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replaceAll('<', String.raw`\u003c`)
}

export interface FaqItem {
  /** The question. */
  q: string
  /** The answer, plain text. */
  a: string
}

/**
 * FAQPage for a marketing page's `::faq` block. Valid markup, but Google
 * shows FAQ rich results only for a few government/health sites since
 * 2023 — it helps other consumers, not rankings.
 */
export function faqStructuredData(items: FaqItem[], inLanguage: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'inLanguage': inLanguage,
    'mainEntity': items.map(item => ({
      '@type': 'Question',
      'name': item.q,
      'acceptedAnswer': { '@type': 'Answer', 'text': item.a }
    }))
  }
}

// ─── Page graphs (every public page below `/`) ─────────────────────────

export interface SiteIds {
  home: string
  organization: string
  website: string
  app: string
}

/** The site-wide node ids, as the home page defines them. */
export function siteIds(siteUrl: string): SiteIds {
  const home = `${siteUrl}/`
  return { home, organization: `${home}#organization`, website: `${home}#website`, app: `${home}#app` }
}

export interface Crumb {
  /** Visible name. */
  name: string
  /** Site-relative path (`/`, `/docs`, …). */
  path: string
}

/** A product a page is about: markoto itself, or another tool by name. */
export type AboutThing = { self: true } | { name: string }

export interface HowToStep {
  name: string
  text: string
}

export interface PageGraphInput {
  /** Public origin, e.g. `https://markoto.app` (no trailing slash). */
  siteUrl: string
  /** Site-relative path of the page (its canonical path). */
  path: string
  /** WebPage subtype of the page itself. */
  pageType?: 'WebPage' | 'CollectionPage'
  /** Page title without the site suffix. */
  name: string
  description: string
  /** BCP 47 tag of the page's language. */
  inLanguage: string
  /** Last substantive change, YYYY-MM-DD (frontmatter `updated`, legal effective date). */
  dateModified?: string
  /** Trail from the home page to this page, both included. */
  breadcrumbs: Crumb[]
  /** Operating entity; '' = no Organization node, no publisher. */
  operatorName: string
  /** Absolute URL of the page's social card. */
  image?: string
  /** What the page is about (WebPage `about`; the article's too). */
  about?: AboutThing[]
  /** The page's main content as an article (docs: TechArticle; comparisons: Article). */
  article?: 'TechArticle' | 'Article'
  /** Only for pages that really are step-by-step instructions. */
  howTo?: { name: string, steps: HowToStep[] }
  /** Pages a hub lists (`CollectionPage` + `ItemList`). */
  itemList?: Crumb[]
  /** Further nodes (e.g. pricing's SoftwareApplication); a top-level `@context` is dropped. */
  extraNodes?: Record<string, unknown>[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD date that is a real calendar day, else undefined. */
export function isoDate(value: string | null | undefined): string | undefined {
  if (!value || !DATE_RE.test(value)) return undefined
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value
}

function absolute(siteUrl: string, path: string): string {
  return path === '/' ? `${siteUrl}/` : `${siteUrl}${path}`
}

/** BreadcrumbList node for a trail (positions from 1, absolute URLs). */
export function breadcrumbNode(siteUrl: string, pageUrl: string, crumbs: Crumb[]): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${pageUrl}#breadcrumb`,
    'itemListElement': crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      'position': i + 1,
      'name': crumb.name,
      'item': absolute(siteUrl, crumb.path)
    }))
  }
}

/**
 * The products a page is about, as graph nodes (each defined once) plus
 * the `{ '@id' }` references the WebPage and the article point at.
 * markoto is the home page's `/#app`; other tools get a page-local id.
 * `definedIds` = ids another node of the graph already defines (pricing's
 * full SoftwareApplication), which are referenced, not redefined.
 */
function aboutGraph(ids: SiteIds, pageUrl: string, about: AboutThing[], definedIds: Set<string>) {
  const nodes: Record<string, unknown>[] = []
  const refs: Record<string, string>[] = []
  about.forEach((thing, i) => {
    const id = 'self' in thing ? ids.app : `${pageUrl}#about-${i + 1}`
    const name = 'self' in thing ? SITE_NAME : thing.name
    if (!definedIds.has(id)) {
      nodes.push({ '@type': 'SoftwareApplication', '@id': id, 'name': name })
      definedIds.add(id)
    }
    refs.push({ '@id': id })
  })
  return { nodes, refs }
}

/**
 * One `@graph` for a public page: Organization + WebSite (so publisher
 * and isPartOf resolve on the page itself), the WebPage, its
 * BreadcrumbList and, when given, the article, HowTo, ItemList and extra
 * nodes. Never ratings or reviews.
 */
export function pageStructuredData(input: PageGraphInput): Record<string, unknown> {
  const ids = siteIds(input.siteUrl)
  const url = absolute(input.siteUrl, input.path)
  const pageId = `${url}#webpage`
  const articleId = `${url}#article`
  const listId = `${url}#itemlist`
  const dateModified = isoDate(input.dateModified)
  const publisher = input.operatorName ? { '@id': ids.organization } : undefined
  const extraNodes = (input.extraNodes ?? []).map(node =>
    Object.fromEntries(Object.entries(node).filter(([k]) => k !== '@context')))
  const definedIds = new Set(extraNodes.map(n => n['@id']).filter((id): id is string => typeof id === 'string'))
  const aboutParts = input.about?.length ? aboutGraph(ids, url, input.about, definedIds) : undefined
  const about = aboutParts?.refs
  const hasList = Boolean(input.itemList?.length)
  let mainEntity: string | undefined
  if (input.article) mainEntity = articleId
  else if (hasList) mainEntity = listId

  const graph: Record<string, unknown>[] = []
  if (input.operatorName) {
    graph.push({ '@type': 'Organization', '@id': ids.organization, 'name': input.operatorName, 'url': ids.home })
  }
  graph.push({
    '@type': 'WebSite',
    '@id': ids.website,
    'name': SITE_NAME,
    'url': ids.home,
    ...(publisher ? { publisher } : {})
  }, {
    '@type': input.pageType ?? 'WebPage',
    '@id': pageId,
    'url': url,
    'name': input.name,
    'description': input.description,
    'inLanguage': input.inLanguage,
    'isPartOf': { '@id': ids.website },
    'breadcrumb': { '@id': `${url}#breadcrumb` },
    ...(dateModified ? { dateModified } : {}),
    ...(about ? { about } : {}),
    ...(input.image ? { primaryImageOfPage: { '@type': 'ImageObject', 'url': input.image } } : {}),
    ...(mainEntity ? { mainEntity: { '@id': mainEntity } } : {})
  }, breadcrumbNode(input.siteUrl, url, input.breadcrumbs))

  if (input.article) {
    graph.push({
      '@type': input.article,
      '@id': articleId,
      // Search engines cut headlines past 110 characters.
      'headline': input.name.slice(0, 110),
      'description': input.description,
      'inLanguage': input.inLanguage,
      'url': url,
      'mainEntityOfPage': { '@id': pageId },
      'isPartOf': { '@id': ids.website },
      ...(dateModified ? { dateModified } : {}),
      ...(input.image ? { image: input.image } : {}),
      ...(publisher ? { publisher, author: publisher } : {}),
      ...(about ? { about } : {})
    })
  }
  if (input.howTo?.steps.length) {
    graph.push({
      '@type': 'HowTo',
      '@id': `${url}#howto`,
      'name': input.howTo.name,
      'inLanguage': input.inLanguage,
      'isPartOf': { '@id': pageId },
      'step': input.howTo.steps.map((step, i) => ({
        '@type': 'HowToStep',
        'position': i + 1,
        'name': step.name,
        'text': step.text
      }))
    })
  }
  if (input.itemList && hasList) {
    graph.push({
      '@type': 'ItemList',
      '@id': listId,
      'itemListElement': input.itemList.map((item, i) => ({
        '@type': 'ListItem',
        'position': i + 1,
        'name': item.name,
        'url': absolute(input.siteUrl, item.path)
      }))
    })
  }
  graph.push(...(aboutParts?.nodes ?? []), ...extraNodes)
  return { '@context': 'https://schema.org', '@graph': graph }
}
