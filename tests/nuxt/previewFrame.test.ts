import { describe, it, expect } from 'vitest'
import { defineComponent, h, ref, computed } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { usePagedPreview } from '~/composables/usePagedPreview'
import {
  PREVIEW_SANDBOX,
  PRINT_SANDBOX,
  buildPreviewSrcdoc,
  attachOwnUploadTokens,
  buildRenderMessage,
  mayReferenceOwnUploads,
  parseFrameMessage,
  withOwnUploadToken
} from '~/utils/previewFrame'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsAssets'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/mermaidAssets'

// The live preview + print iframes run in an OPAQUE origin (sandbox without
// allow-same-origin) — see app/utils/previewFrame.ts. These tests pin the
// host side: the sandbox flags, the srcdoc substitution and the message /
// URL helpers. The browser-level isolation (no cookie / storage / parent
// access from inside the preview) is pinned by the Playwright flow
// tests/e2e/flows/preview-isolation.spec.ts.

describe('preview iframe sandbox', () => {
  it('never grants allow-same-origin', () => {
    expect(PREVIEW_SANDBOX.split(/\s+/)).toEqual(['allow-scripts'])
    expect(PRINT_SANDBOX.split(/\s+/).sort()).toEqual(['allow-modals', 'allow-scripts'])
    for (const flags of [PREVIEW_SANDBOX, PRINT_SANDBOX]) {
      expect(flags).not.toContain('allow-same-origin')
      expect(flags).not.toContain('allow-top-navigation')
      expect(flags).not.toContain('allow-popups')
    }
  })

  it('usePagedPreview mounts the iframe with the opaque-origin sandbox', async () => {
    const container = ref<HTMLElement | null>(null)
    const Host = defineComponent({
      setup() {
        usePagedPreview({
          html: ref('<p>Hello</p>'),
          theme: ref(defaultTheme),
          title: ref('Doc'),
          docId: computed(() => 'doc-1'),
          container
        })
        return () => h('div', { ref: container, class: 'host' })
      }
    })
    const wrapper = await mountSuspended(Host)
    const iframe = wrapper.element.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('srcdoc') ?? '').toContain(PAGEDJS_POLYFILL_URL)
    wrapper.unmount()
  })
})

describe('buildPreviewSrcdoc', () => {
  it('substitutes every placeholder', () => {
    const out = buildPreviewSrcdoc({ parentOrigin: 'https://markoto.app', nonce: 'bm9uY2UtMTIzNDU2Nzg5MA==', dark: true })
    expect(out).not.toMatch(/__[A-Z_]+__/)
    expect(out).toContain('var PARENT_ORIGIN = \'https://markoto.app\';')
    expect(out).toContain('nonce="bm9uY2UtMTIzNDU2Nzg5MA=="')
    expect(out).toContain('applyColorMode(true);')
    expect(out).toContain(`var MERMAID_URL = '${MERMAID_URL}';`)
    expect(out).toContain(`var MERMAID_SRI = '${MERMAID_SRI}';`)
  })

  it('refuses to inject anything but a base64 nonce / a plain origin', () => {
    const out = buildPreviewSrcdoc({ parentOrigin: 'https://x\';alert(1)//', nonce: '"><script>', dark: false })
    expect(out).toContain('var PARENT_ORIGIN = \'\';')
    expect(out).not.toContain('"><script>')
    expect(out).toContain('nonce=""')
  })
})

describe('parseFrameMessage', () => {
  const frame = {} as Window
  const ev = (data: unknown, opts: { source?: unknown, origin?: string } = {}) =>
    new MessageEvent('message', { data, origin: opts.origin ?? 'null', source: (opts.source ?? frame) as MessageEventSource })

  it('accepts protocol messages from the iframe (opaque origin)', () => {
    expect(parseFrameMessage(ev({ type: 'iframe-ready' }), frame)).toEqual({ type: 'iframe-ready' })
    expect(parseFrameMessage(ev({ type: 'paginated', pageCount: 3.7 }), frame)).toEqual({ type: 'paginated', pageCount: 3 })
    expect(parseFrameMessage(ev({ type: 'print-done' }), frame)).toEqual({ type: 'print-done' })
  })

  it('rejects other windows, non-opaque origins and malformed payloads', () => {
    expect(parseFrameMessage(ev({ type: 'iframe-ready' }, { source: {} }), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'iframe-ready' }, { origin: 'https://evil.example' }), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'paginated', pageCount: '3' }), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'paginated', pageCount: -1 }), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'iframe-error' }), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'navigate', url: 'https://x' }), frame)).toBeNull()
    expect(parseFrameMessage(ev('iframe-ready'), frame)).toBeNull()
    expect(parseFrameMessage(ev({ type: 'iframe-ready' }), null)).toBeNull()
  })
})

describe('file-access token attachment (own uploads only)', () => {
  it('adds the token to exact own-upload URLs only', () => {
    expect(withOwnUploadToken('/api/files/doc-1/abc_DEF-12.png', 'doc-1', 'aaa.bbb.ccc')).toBe('/api/files/doc-1/abc_DEF-12.png?token=aaa.bbb.ccc')
    for (const url of [
      '/api/files/doc-2/x.png', // another document
      '/api/files/doc-1/y.jpg?x=1', // already has a query
      'https://evil.example/api/files/doc-1/x.png', // merely contains the path
      '/api/files/doc-1/x.svg' // not an image upload shape
    ]) {
      expect(withOwnUploadToken(url, 'doc-1', 't'), url).toBe(url)
    }
    expect(withOwnUploadToken('/api/files/doc-1/x.png', 'doc-1', '')).toBe('/api/files/doc-1/x.png')
  })

  it('touches <img src> only — never links or text', () => {
    const html = '<p><img src="/api/files/doc-1/a.png" alt=""><a href="/api/files/doc-1/a.png">link</a> /api/files/doc-1/a.png</p>'
    const out = attachOwnUploadTokens(html, 'doc-1', 'tok')
    expect(out).toContain('<img src="/api/files/doc-1/a.png?token=tok"')
    expect(out).toContain('<a href="/api/files/doc-1/a.png">')
    expect(out).toContain('</a> /api/files/doc-1/a.png</p>')
    expect(attachOwnUploadTokens(html, 'doc-1', '')).toBe(html)
  })

  it('header/footer images in the theme CSS get the token via themeToCss', () => {
    const theme = structuredClone(defaultTheme)
    theme.header.imageUrl = '/api/files/doc-1/head.png'
    const msg = buildRenderMessage({ html: '<p>x</p>', theme, title: 'T', language: 'en', customCss: undefined, docId: 'doc-1', fileToken: 'tok', print: false })
    expect(msg.themeCss).toContain('/api/files/doc-1/head.png?token=tok')
    expect(mayReferenceOwnUploads({ html: '<p>x</p>', theme, rawCustomCss: '', docId: 'doc-1' })).toBe(true)
    expect(mayReferenceOwnUploads({ html: '<p>x</p>', theme: defaultTheme, rawCustomCss: '', docId: 'doc-1' })).toBe(false)
  })
})

describe('documents at scale — render message + srcdoc', () => {
  it('sends the document-matched mermaid config and the document locale', () => {
    const theme = structuredClone(defaultTheme)
    theme.mermaid.theme = 'document'
    theme.cover.date = '2026-10-29'
    const msg = buildRenderMessage({ html: '<p>x</p>', theme, title: 'T', language: 'de', customCss: undefined, docId: 'doc-1', fileToken: '', print: false })
    const cfg: unknown = JSON.parse(msg.mermaidConfig)
    expect(typeof cfg === 'object' && cfg !== null ? Reflect.get(cfg, 'securityLevel') : null).toBe('antiscript')
    expect(typeof cfg === 'object' && cfg !== null ? Reflect.get(cfg, 'theme') : null).toBe('base')
    expect(msg.locale).toBe('de')
    // Localised TOC title in the theme CSS.
    expect(msg.themeCss).toContain('content: "Inhalt";')
  })

  it('inlines the pagination handlers into the srcdoc, nonce\'d, without a raw placeholder', () => {
    const srcdoc = buildPreviewSrcdoc({ parentOrigin: 'https://markoto.app', nonce: 'bm9uY2Utbm9uY2Utbm9uY2U=', dark: false })
    expect(srcdoc).not.toContain('__PAGED_HANDLERS_SCRIPT__')
    expect(srcdoc).toContain('<script nonce="bm9uY2Utbm9uY2Utbm9uY2U=">(function registerPagedHandlers')
    expect(srcdoc).toContain('(globalThis.Paged);</script>')
  })
})
