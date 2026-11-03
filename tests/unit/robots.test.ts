import { describe, it, expect } from 'vitest'
import { NOINDEX_VALUE, robotsTagFor, robotsTxt } from '../../server/utils/robots'

// Documents stay out of search engines; marketing, docs, pricing and
// legal pages stay indexable (server/utils/robots.ts).

describe('robotsTagFor', () => {
  it('noindexes every document and the render / document API routes', () => {
    for (const path of ['/d/abc', '/d/abc?x=1', '/d', '/_internal/render/abc?t=1', '/api/docs/abc/pdf']) {
      expect(robotsTagFor(path), path).toBe(NOINDEX_VALUE)
    }
  })

  it('leaves the public site indexable', () => {
    for (const path of ['/', '/docs', '/docs/getting-started', '/pricing', '/legal/terms', '/legal/abuse', '/dashboard', '/download']) {
      expect(robotsTagFor(path), path).toBeNull()
    }
  })

  it('the header value is exactly noindex, nofollow', () => {
    expect(NOINDEX_VALUE).toBe('noindex, nofollow')
  })
})

describe('robotsTxt', () => {
  const lines = robotsTxt().split('\n')
  it('disallows internals for every agent', () => {
    expect(lines[0]).toBe('User-agent: *')
    expect(lines).toContain('Disallow: /_internal/')
    expect(lines).toContain('Disallow: /api/')
  })
  it('does not disallow documents (crawlers must fetch them to see noindex) nor the public pages', () => {
    for (const p of ['/d', '/', '/docs', '/pricing', '/legal']) {
      expect(lines.some(l => l === `Disallow: ${p}` || l === `Disallow: ${p}/`), p).toBe(false)
    }
  })
})
