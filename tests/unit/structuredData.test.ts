import { describe, it, expect } from 'vitest'
import { homeStructuredData, serializeJsonLd } from '../../shared/seo/structuredData'

// JSON-LD on markoto.app's home page: Organization + WebSite +
// SoftwareApplication (free). Nothing invented — no ratings, no reviews.

const input = {
  siteUrl: 'https://markoto.app',
  operatorName: 'LatentSpace Labs GmbH',
  description: 'A collaborative Markdown editor.',
  inLanguage: 'en-US'
}

describe('homeStructuredData', () => {
  it('has the three nodes, linked to the operating entity', () => {
    const data = homeStructuredData(input)
    expect(data['@context']).toBe('https://schema.org')
    const graph = data['@graph']
    expect(Array.isArray(graph)).toBe(true)
    const text = JSON.stringify(data)
    expect(text).toContain('"@type":"Organization"')
    expect(text).toContain('"name":"LatentSpace Labs GmbH"')
    expect(text).toContain('"@type":"WebSite"')
    expect(text).toContain('"@type":"SoftwareApplication"')
    expect(text).toContain('"offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}')
    expect(text).toContain('"publisher":{"@id":"https://markoto.app/#organization"}')
  })

  it('never claims ratings or reviews', () => {
    const text = JSON.stringify(homeStructuredData(input))
    expect(text).not.toMatch(/aggregateRating|review/i)
  })

  it('leaves the Organization out when no operator is known', () => {
    const text = JSON.stringify(homeStructuredData({ ...input, operatorName: '' }))
    expect(text).not.toContain('Organization')
    expect(text).not.toContain('publisher')
  })
})

describe('serializeJsonLd', () => {
  it('escapes < so a value cannot close the script element', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script>' })
    expect(json).not.toContain('<')
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script>' })
  })
})
