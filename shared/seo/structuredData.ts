// schema.org JSON-LD for the hosted home page (`/` on markoto.app).
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

/**
 * JSON for an inline `<script type="application/ld+json">`. `<` is
 * escaped so no value can close the script element early.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replaceAll('<', String.raw`\u003c`)
}
