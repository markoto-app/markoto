import { describe, it, expect } from 'vitest'
import { canonicalUrl, isDocsPath, isNoindexPath, pathnameOf } from '../../shared/seo/paths'

// Canonical links: NUXT_SITE_URL + path, no query, never the Host header.
// Self-hosted docs point at markoto.app (owner decision, SEO-1).

const hosted = { siteUrl: 'https://markoto.app', docsCanonicalBase: '' }
const selfHosted = { siteUrl: 'https://docs.example.com', docsCanonicalBase: 'https://markoto.app' }

describe('canonicalUrl', () => {
  it('builds site URL + path and drops query + fragment', () => {
    expect(canonicalUrl('/', hosted)).toBe('https://markoto.app/')
    expect(canonicalUrl('/pricing?utm_source=x#plans', hosted)).toBe('https://markoto.app/pricing')
    expect(canonicalUrl('/legal/terms/', hosted)).toBe('https://markoto.app/legal/terms')
  })

  it('emits nothing without a site URL (never guessed from the request)', () => {
    expect(canonicalUrl('/pricing', { siteUrl: '', docsCanonicalBase: '' })).toBeNull()
  })

  it('emits nothing for documents and internal routes', () => {
    for (const path of ['/d', '/d/abc', '/_internal/render/abc']) {
      expect(canonicalUrl(path, hosted), path).toBeNull()
    }
  })

  it('points self-hosted docs at markoto.app, keeps the rest self-canonical', () => {
    expect(canonicalUrl('/docs', selfHosted)).toBe('https://markoto.app/docs')
    expect(canonicalUrl('/docs/sharing/qr-code?x=1', selfHosted)).toBe('https://markoto.app/docs/sharing/qr-code')
    expect(canonicalUrl('/pricing', selfHosted)).toBe('https://docs.example.com/pricing')
    expect(canonicalUrl('/docsy', selfHosted)).toBe('https://docs.example.com/docsy')
  })

  it('docs canonical works even when the self-hosted site URL is unset', () => {
    expect(canonicalUrl('/docs/themes', { siteUrl: '', docsCanonicalBase: 'https://markoto.app' }))
      .toBe('https://markoto.app/docs/themes')
  })

  it('hosted docs are self-canonical', () => {
    expect(canonicalUrl('/docs/themes', hosted)).toBe('https://markoto.app/docs/themes')
  })
})

describe('path helpers', () => {
  it('pathnameOf strips query and fragment', () => {
    expect(pathnameOf('/a?b=1')).toBe('/a')
    expect(pathnameOf('/a#b')).toBe('/a')
    expect(pathnameOf('/a')).toBe('/a')
  })
  it('isDocsPath matches /docs and below only', () => {
    expect(isDocsPath('/docs')).toBe(true)
    expect(isDocsPath('/docs/x')).toBe(true)
    expect(isDocsPath('/docsx')).toBe(false)
  })
  it('isNoindexPath covers documents, render page and document API', () => {
    expect(isNoindexPath('/d')).toBe(true)
    expect(isNoindexPath('/api/docs/x/pdf')).toBe(true)
    expect(isNoindexPath('/docs')).toBe(false)
  })
})
