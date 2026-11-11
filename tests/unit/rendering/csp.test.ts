import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { addNonceToScripts, buildAppCsp, buildRenderCsp, crossOriginResourcePolicyFor } from '../../../server/utils/rendering/csp'
import { MERMAID_URL, MERMAID_SRI } from '../../../shared/utils/vendor/mermaidAssets'
import { hljsTheme, HLJS_STYLES_BASE } from '../../../shared/utils/vendor/hljsAssets'
import { CodeThemeSchema } from '../../../shared/types/theme'

// Regression pins for the Content-Security-Policy (server/utils/rendering/csp.ts,
// applied by server/plugins/csp.ts). The exact app policy is pinned as a
// string so any loosening shows up in review as a test diff.

const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY3OA=='

function directive(policy: string, name: string): string {
  return policy.split('; ').find(d => d === name || d.startsWith(`${name} `)) ?? ''
}

describe('buildAppCsp', () => {
  const hosted = buildAppCsp({
    nonce: NONCE,
    syncUrl: 'wss://sync.markoto.app',
    s3Origin: 'https://s3.gra.io.cloud.ovh.net/',
    sentryDsn: 'https://abc@o1.ingest.de.sentry.io/42',
    siteUrl: 'https://markoto.app'
  })

  it('pins the hosted policy', () => {
    expect(hosted).toBe([
      'default-src \'self\'',
      `script-src 'self' 'nonce-${NONCE}' 'wasm-unsafe-eval'`,
      'style-src \'self\' \'unsafe-inline\'',
      'font-src \'self\' data:',
      'img-src \'self\' data: blob: https://s3.gra.io.cloud.ovh.net',
      'connect-src \'self\' wss://sync.markoto.app https://s3.gra.io.cloud.ovh.net https://o1.ingest.de.sentry.io',
      'frame-src \'self\'',
      'worker-src \'self\' blob:',
      'manifest-src \'self\'',
      'media-src \'self\' blob:',
      'object-src \'none\'',
      'base-uri \'self\'',
      'form-action \'self\'',
      'frame-ancestors \'none\'',
      'upgrade-insecure-requests'
    ].join('; '))
  })

  it('never allows inline script, eval or any CDN', () => {
    const script = directive(hosted, 'script-src')
    expect(script).not.toContain('\'unsafe-inline\'')
    expect(script).not.toContain('\'unsafe-eval\'')
    expect(script).not.toContain('*')
    // paged.js, Mermaid, KaTeX, highlight.js and the web fonts are served
    // from our own origin (/vendor/): no third-party host in the policy.
    for (const host of ['jsdelivr', 'googleapis', 'gstatic', 'unpkg', 'cdnjs']) expect(hosted).not.toContain(host)
  })

  it('self-host over plain HTTP: no upgrade-insecure-requests, same-origin sync + S3', () => {
    const selfHost = buildAppCsp({ nonce: NONCE, syncUrl: '/sync', s3Origin: 'http://docs.example.org:8080/markoto-files', siteUrl: 'http://docs.example.org:8080' })
    expect(selfHost).not.toContain('upgrade-insecure-requests')
    expect(directive(selfHost, 'connect-src')).toBe('connect-src \'self\' http://docs.example.org:8080')
    expect(directive(selfHost, 'img-src')).toBe('img-src \'self\' data: blob: http://docs.example.org:8080')
  })

  it('drops a malformed nonce instead of writing it into the header', () => {
    const bad = buildAppCsp({ nonce: '\'; script-src *', syncUrl: '' })
    expect(directive(bad, 'script-src')).not.toContain('nonce')
    expect(bad).not.toContain('script-src *')
  })

  it('the render page allows scripts, styles and fonts from the app origin only, like the app', () => {
    const render = buildRenderCsp({ nonce: NONCE, s3Origin: undefined, extraOrigins: undefined })
    expect(directive(render, 'script-src')).toBe(`script-src 'self' 'nonce-${NONCE}'`)
    expect(directive(render, 'style-src')).toBe(directive(hosted, 'style-src'))
    expect(directive(render, 'font-src')).toBe(directive(hosted, 'font-src'))
  })
})

describe('addNonceToScripts', () => {
  it('stamps every script start tag once', () => {
    const out = addNonceToScripts('<script>a()</script><script type="module" src="/_nuxt/x.js"></script><script nonce="old">b()</script>', NONCE)
    expect(out).toBe(`<script nonce="${NONCE}">a()</script><script nonce="${NONCE}" type="module" src="/_nuxt/x.js"></script><script nonce="old">b()</script>`)
  })
  it('ignores tags that merely start with "script"', () => {
    expect(addNonceToScripts('<scripted>', NONCE)).toBe('<scripted>')
  })
  it('does nothing with an invalid nonce', () => {
    expect(addNonceToScripts('<script>', '"><x')).toBe('<script>')
  })
})

describe('vendored asset pins', () => {
  it('every highlight.js theme has an SRI hash under the pinned same-origin path', () => {
    for (const theme of CodeThemeSchema.options) {
      const { url, sri } = hljsTheme(theme)
      if (theme === 'none') {
        expect(url).toBe('')
        continue
      }
      expect(url.startsWith(HLJS_STYLES_BASE)).toBe(true)
      expect(sri).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
    }
  })
  it('mermaid is the single-file build with SRI (dynamic import() cannot be SRI-checked)', () => {
    expect(MERMAID_URL).toMatch(/^\/vendor\/mermaid@\d+\.\d+\.\d+\/mermaid\.min\.js$/)
    expect(MERMAID_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
  })
})

describe('deployment config', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8')
  it.each([
    'docker-compose.prod.yml',
    'docker-compose.selfhost.yml',
    'docker-compose.selfhost.tls.yml',
    'docker-compose.local.yml'
  ])('%s leaves the app CSP + CORP to the app (no second, looser policy at the proxy)', (file) => {
    const text = read(file)
    // The self-host S3 route keeps its own sandbox CSP (object responses only).
    const appLabels = text.split('\n').filter(l => /traefik\.http\.middlewares\./.test(l) && !l.includes('markoto-s3-headers'))
    expect(appLabels.filter(l => /contentSecurityPolicy|Content-Security-Policy/.test(l))).toEqual([])
    expect(appLabels.filter(l => /Cross-Origin-Resource-Policy/.test(l) && !l.includes('sync-security-headers'))).toEqual([])
  })
})

describe('crossOriginResourcePolicyFor', () => {
  // The preview iframes are opaque-origin: what they load must be cross-origin.
  it('lets the preview iframe load uploads, the bundled cover logos and the vendored assets', () => {
    expect(crossOriginResourcePolicyFor('/api/files/abc/def')).toBe('cross-origin')
    // Brand-kit fonts + logos of a document (WP10), with the token query.
    expect(crossOriginResourcePolicyFor('/api/docs/abc/brand/AbCdEfGhIjKlMnOp.woff2?token=x')).toBe('cross-origin')
    expect(crossOriginResourcePolicyFor('/api/docs/abc/brand')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/api/docs/abc/token')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/markoto-logos/primary-lockup-light.svg')).toBe('cross-origin')
    expect(crossOriginResourcePolicyFor(MERMAID_URL)).toBe('cross-origin')
    expect(crossOriginResourcePolicyFor('/vendor/fonts/inter.css')).toBe('cross-origin')
  })

  it('keeps everything else same-site', () => {
    expect(crossOriginResourcePolicyFor('/')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/api/docs/abc/meta')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/markoto-logosX/a.svg')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/_nuxt/entry.js')).toBe('same-site')
    expect(crossOriginResourcePolicyFor('/vendorX/a.js')).toBe('same-site')
  })

  it('keeps a published page\'s files to the host that serves the page', () => {
    expect(crossOriginResourcePolicyFor('/api/published/PageId0123456789/files/a.png')).toBe('same-origin')
    expect(crossOriginResourcePolicyFor('/api/published/PageId0123456789/brand/f.woff2?x=1')).toBe('same-origin')
  })
})
