import { describe, it, expect } from 'vitest'
import { anonClient } from '../setup/client'

// User documents stay out of search engines (server/utils/platform/robots.ts,
// server/plugins/robots.ts, server/routes/robots.txt.ts); the public site
// stays indexable.

describe('X-Robots-Tag', () => {
  it('every document page is noindex, nofollow (also unknown ids)', async () => {
    const res = await anonClient().get('/d/some-doc-id')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const html = await res.text()
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/)
  })

  it('the internal render page and the document API are noindex', async () => {
    expect((await anonClient().get('/_internal/render/some-doc-id')).headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect((await anonClient().get('/api/docs/some-doc-id/meta')).headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('landing, docs, pricing and legal pages carry no robots header', async () => {
    for (const path of ['/', '/pricing', '/legal/terms']) {
      const res = await anonClient().get(path)
      expect(res.headers.get('x-robots-tag'), path).toBeNull()
    }
  })
})

describe('GET /robots.txt', () => {
  it('disallows internals but lets crawlers fetch documents (to see their noindex)', async () => {
    const res = await anonClient().get('/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('User-agent: *')
    expect(body).not.toContain('Disallow: /d/')
    expect(body).toContain('Disallow: /_internal/')
    expect(body).not.toMatch(/^Disallow: \/$/m)
  })
})
