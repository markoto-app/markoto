import { describe, it, expect } from 'vitest'
import { defineComponent, h, ref, computed } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { usePagedPreview } from '~/composables/usePagedPreview'
import {
  PREVIEW_SANDBOX,
  PRINT_SANDBOX,
  buildPreviewSrcdoc,
  parseFrameMessage,
  referencesDocFiles,
  withFileAccessToken
} from '~/utils/previewFrame'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsCdn'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/mermaidCdn'

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

describe('withFileAccessToken', () => {
  const html = '<img src="/api/files/doc-1/abc_DEF-12.png"><img src="/api/files/doc-2/x.png"><img src="/api/files/doc-1/y.jpg?token=old">'

  it('appends the token to this document\'s image URLs only', () => {
    const out = withFileAccessToken(html, 'doc-1', 'aaa.bbb.ccc')
    expect(out).toContain('/api/files/doc-1/abc_DEF-12.png?token=aaa.bbb.ccc"')
    expect(out).toContain('/api/files/doc-2/x.png"')
    // Already carries a query: left alone.
    expect(out).toContain('/api/files/doc-1/y.jpg?token=old"')
  })

  it('works inside CSS url()', () => {
    expect(withFileAccessToken('a{background:url("/api/files/doc-1/bg.webp")}', 'doc-1', 't'))
      .toBe('a{background:url("/api/files/doc-1/bg.webp?token=t")}')
  })

  it('treats the doc id literally (no regex injection)', () => {
    expect(referencesDocFiles('/api/files/docX1/a.png', 'doc.1')).toBe(false)
    expect(referencesDocFiles('/api/files/doc.1/a.png', 'doc.1')).toBe(true)
  })

  it('is a no-op without a token', () => {
    expect(withFileAccessToken(html, 'doc-1', '')).toBe(html)
  })
})
