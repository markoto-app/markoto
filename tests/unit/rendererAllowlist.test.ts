import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CDN_ORIGINS,
  buildAllowedOrigins,
  hostForLog,
  isAllowedUrl,
  originOf
} from '../../renderer/src/allowlist'
import { buildRenderCsp } from '../../server/utils/renderCsp'
import { PAGEDJS_POLYFILL_URL } from '../../shared/utils/pagedjsCdn'
import { MERMAID_ESM_URL } from '../../shared/utils/mermaidCdn'
import { KATEX_CSS_URL } from '../../shared/utils/katexCdn'

const hosted = buildAllowedOrigins({
  APP_URL: 'http://markoto-app:3000',
  S3_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net'
})

describe('originOf', () => {
  it('normalises default ports and paths', () => {
    expect(originOf('https://example.org:443/a/b?c')).toBe('https://example.org')
    expect(originOf(' http://app:3000/ ')).toBe('http://app:3000')
  })
  it('rejects empty, relative and non-http values', () => {
    for (const v of ['', '   ', 'app:3000', '/x', 'ftp://h/', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(originOf(v)).toBeNull()
    }
  })
})

describe('buildAllowedOrigins', () => {
  it('derives app, S3 and CDN origins from the environment', () => {
    expect(hosted.has('http://markoto-app:3000')).toBe(true)
    expect(hosted.has('https://s3.gra.io.cloud.ovh.net')).toBe(true)
    for (const cdn of DEFAULT_CDN_ORIGINS) expect(hosted.has(cdn)).toBe(true)
  })

  it('prefers S3_PUBLIC_ENDPOINT over the internal S3_ENDPOINT', () => {
    const selfHost = buildAllowedOrigins({
      APP_URL: 'http://markoto-app:3000',
      S3_ENDPOINT: 'http://seaweedfs:8333',
      S3_PUBLIC_ENDPOINT: 'https://docs.example.org'
    })
    expect(selfHost.has('https://docs.example.org')).toBe(true)
    expect(selfHost.has('http://seaweedfs:8333')).toBe(false)
  })

  it('adds RENDERER_ALLOWED_ORIGINS entries and skips junk', () => {
    const o = buildAllowedOrigins({
      APP_URL: 'http://app:3000',
      RENDERER_ALLOWED_ORIGINS: 'https://img.example.org, ,not-a-url,http://assets:9000/path'
    })
    expect(o.has('https://img.example.org')).toBe(true)
    expect(o.has('http://assets:9000')).toBe(true)
    expect(o.size).toBe(DEFAULT_CDN_ORIGINS.length + 3)
  })

  it('still builds a safe set with nothing configured', () => {
    expect([...buildAllowedOrigins({})].sort()).toEqual([...DEFAULT_CDN_ORIGINS].sort())
  })
})

describe('isAllowedUrl', () => {
  it('allows the app, the S3 host and every CDN URL the print page loads', () => {
    expect(isAllowedUrl('http://markoto-app:3000/_internal/render/abc?t=x', hosted)).toBe(true)
    expect(isAllowedUrl('https://s3.gra.io.cloud.ovh.net/bucket/docs/a/b.png?X-Amz-Signature=1', hosted)).toBe(true)
    for (const url of [
      PAGEDJS_POLYFILL_URL,
      MERMAID_ESM_URL,
      KATEX_CSS_URL,
      'https://cdn.jsdelivr.net/npm/highlight.js@11.12.0/styles/github.min.css',
      'https://fonts.googleapis.com/css2?family=Inter&display=swap',
      'https://fonts.gstatic.com/s/inter/v1/x.woff2'
    ]) {
      expect(isAllowedUrl(url, hosted), url).toBe(true)
    }
  })

  it('allows in-browser schemes', () => {
    expect(isAllowedUrl('data:image/png;base64,AAAA', hosted)).toBe(true)
    expect(isAllowedUrl('blob:http://markoto-app:3000/uuid', hosted)).toBe(true)
    expect(isAllowedUrl('about:blank', hosted)).toBe(true)
  })

  it('blocks cloud metadata and internal services', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://litellm:4000/key/info',
      'http://valkey:6379/',
      'http://postgres:5432/',
      'http://localhost:3000/',
      'http://127.0.0.1:9000/health',
      'http://sync:4001/internal/x'
    ]) {
      expect(isAllowedUrl(url, hosted), url).toBe(false)
    }
  })

  it('matches scheme + host + port exactly, not by prefix or suffix', () => {
    expect(isAllowedUrl('http://markoto-app:3001/', hosted)).toBe(false)
    expect(isAllowedUrl('https://markoto-app:3000/', hosted)).toBe(false)
    expect(isAllowedUrl('http://markoto-app.evil.example:3000/', hosted)).toBe(false)
    expect(isAllowedUrl('https://cdn.jsdelivr.net.evil.example/x.js', hosted)).toBe(false)
    expect(isAllowedUrl('https://evil.example/https://cdn.jsdelivr.net/', hosted)).toBe(false)
    // userinfo trick: the real host is the one after the @.
    expect(isAllowedUrl('http://markoto-app:3000@169.254.169.254/', hosted)).toBe(false)
    expect(isAllowedUrl('https://cdn.jsdelivr.net@evil.example/', hosted)).toBe(false)
  })

  it('blocks websockets and other schemes, and unparseable input', () => {
    for (const url of [
      'ws://markoto-app:3000/_nuxt/hmr',
      'wss://cdn.jsdelivr.net/',
      'ftp://markoto-app/x',
      'file:///etc/passwd',
      'about:srcdoc',
      'javascript:alert(1)',
      'not a url',
      ''
    ]) {
      expect(isAllowedUrl(url, hosted), url).toBe(false)
    }
  })
})

describe('hostForLog', () => {
  it('logs the host only, never path, query or credentials', () => {
    expect(hostForLog('http://user:pw@169.254.169.254:80/latest?token=secret')).toBe('169.254.169.254')
    expect(hostForLog('http://litellm:4000/key/info?k=1')).toBe('litellm:4000')
    expect(hostForLog('garbage')).toBe('unparseable')
  })
})

describe('buildRenderCsp', () => {
  const csp = buildRenderCsp({
    s3Origin: 'https://s3.gra.io.cloud.ovh.net/',
    extraOrigins: 'https://img.example.org,junk'
  })
  const directive = (policy: string, name: string) =>
    policy.split('; ').find(d => d.startsWith(`${name} `)) ?? ''

  it('locks everything down by default', () => {
    expect(directive(csp, 'default-src')).toBe('default-src \'none\'')
    expect(directive(csp, 'object-src')).toContain('\'none\'')
    expect(directive(csp, 'frame-src')).toContain('\'none\'')
  })

  it('limits images to self, data/blob, the S3 origin and operator extras', () => {
    expect(directive(csp, 'img-src')).toBe(
      'img-src \'self\' data: blob: https://s3.gra.io.cloud.ovh.net https://img.example.org'
    )
  })

  it('keeps the CDNs the print page needs', () => {
    expect(directive(csp, 'script-src')).toContain('https://cdn.jsdelivr.net')
    expect(directive(csp, 'style-src')).toContain('https://fonts.googleapis.com')
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com')
  })

  it('does not widen img-src when S3 and extras are unset', () => {
    const bare = buildRenderCsp({ s3Origin: undefined, extraOrigins: undefined })
    expect(directive(bare, 'img-src')).toBe('img-src \'self\' data: blob:')
  })
})
