// The production build serves paged.js, Mermaid, KaTeX, highlight.js and the
// web fonts itself under /vendor/ (shared/utils/vendor/vendorAssets.ts). The
// preview / print iframes run in an opaque origin, so these responses must
// be loadable cross-origin (CORP) and in CORS mode (fonts, SRI tags), and
// cache headers must match the versioned / unversioned split.

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { anonClient } from '../setup/client'
import { MERMAID_SRI, MERMAID_URL } from '../../../shared/utils/vendor/mermaidAssets'
import { PAGEDJS_POLYFILL_SRI, PAGEDJS_POLYFILL_URL } from '../../../shared/utils/vendor/pagedjsAssets'
import { KATEX_CSS_SRI, KATEX_CSS_URL } from '../../../shared/utils/vendor/katexAssets'
import { hljsTheme } from '../../../shared/utils/vendor/hljsAssets'
import { fontStylesheetUrl } from '../../../shared/utils/theme/themeFonts'

const sri = (bytes: ArrayBuffer) => `sha384-${createHash('sha384').update(Buffer.from(bytes)).digest('base64')}`

describe('GET /vendor/*', () => {
  it.each([
    [PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI, 'javascript'],
    [MERMAID_URL, MERMAID_SRI, 'javascript'],
    [KATEX_CSS_URL, KATEX_CSS_SRI, 'text/css'],
    [hljsTheme('github-dark').url, hljsTheme('github-dark').sri, 'text/css']
  ])('%s: the SRI-pinned bytes, cross-origin loadable, immutable', async (url, hash, type) => {
    const res = await anonClient().get(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain(type)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(sri(await res.arrayBuffer())).toBe(hash)
  })

  it('serves a font stylesheet that revalidates and points at woff2 files on this origin', async () => {
    const res = await anonClient().get(fontStylesheetUrl('Inter') ?? '')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const css = await res.text()
    expect(css).toContain('font-family: \'Inter\'')
    expect(css).not.toMatch(/https?:\/\//)
    const first = /url\('([^']+\.woff2)'\)/.exec(css)?.[1]
    expect(first).toBeDefined()

    const font = await anonClient().get(`/vendor/fonts/${first}`)
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toContain('font/woff2')
    expect(font.headers.get('access-control-allow-origin')).toBe('*')
    expect(font.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(font.headers.get('cache-control')).toContain('immutable')
  })

  it('serves KaTeX\'s woff2 fonts next to its stylesheet', async () => {
    const res = await anonClient().get(new URL('fonts/KaTeX_Main-Regular.woff2', `http://x${KATEX_CSS_URL}`).pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers 404 for anything that was not vendored (no SPA fallback)', async () => {
    const res = await anonClient().get('/vendor/mermaid@0.0.0/mermaid.min.js')
    expect(res.status).toBe(404)
  })
})
