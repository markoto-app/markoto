// schema.org JSON-LD for the hosted home page (`/` on markoto.app) and
// its pricing page.
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
  const orgId = `${home}#organization`
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
