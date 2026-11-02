import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// Static contract of the preview / print iframe bootstrap
// (app/composables/pagedPreviewIframe.html). The document runs sandboxed in
// an OPAQUE origin (no allow-same-origin) and inherits the app's nonce-based
// CSP, so it must:
//   - talk to the parent only via postMessage, to the parent's exact origin,
//     and accept messages only from window.parent with that origin;
//   - never reach into window.parent's DOM (it would throw anyway);
//   - carry the CSP nonce on every inline script and use no inline event
//     handlers (no 'unsafe-inline' in script-src);
//   - load every CDN asset with SRI + crossorigin=anonymous.
// The substitution itself (buildPreviewSrcdoc) is covered in
// tests/nuxt/previewFrame.test.ts.
//
// Loaded via readFileSync (not `?raw`) so this stays a plain unit test.
const BOOTSTRAP_HTML = readFileSync(
  fileURLToPath(new URL('../../app/composables/pagedPreviewIframe.html', import.meta.url)),
  'utf8'
)
const WITHOUT_COMMENT = BOOTSTRAP_HTML.replace(/<!--[\s\S]*?-->/, '')

const PLACEHOLDERS = [
  '__CSP_NONCE__',
  '__PARENT_ORIGIN__',
  '__INITIAL_DARK__',
  '__PAGEDJS_POLYFILL_URL__',
  '__PAGEDJS_POLYFILL_SRI__',
  '__KATEX_CSS_URL__',
  '__KATEX_CSS_SRI__',
  '__MERMAID_URL__',
  '__MERMAID_SRI__',
  '__PAGED_HANDLERS_SCRIPT__'
]

describe('pagedPreviewIframe.html', () => {
  it('uses each placeholder at a real usage site and no unknown ones', () => {
    for (const p of PLACEHOLDERS) expect(WITHOUT_COMMENT, p).toContain(p)
    const used = new Set(WITHOUT_COMMENT.match(/__[A-Z_]+__/g) ?? [])
    expect([...used].sort()).toEqual([...PLACEHOLDERS].sort())
  })

  it('carries the CSP nonce on every inline script and has no inline handlers', () => {
    // Real tags start a line; `<script>` inside JS comments is prose.
    const scripts = WITHOUT_COMMENT.match(/^<script\b[^>]*>/gm) ?? []
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) {
      if (tag.includes(' src=')) continue
      expect(tag).toContain('nonce="__CSP_NONCE__"')
    }
    // on*="…" attributes run only with 'unsafe-inline' — the CSP has none.
    expect(WITHOUT_COMMENT).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i)
  })

  it('never touches the parent document (opaque origin)', () => {
    expect(WITHOUT_COMMENT).not.toMatch(/window\.parent\.document|parent\.document/)
    expect(WITHOUT_COMMENT).not.toContain('__renderDoc')
  })

  it('posts to the parent origin only and checks the sender of incoming messages', () => {
    // Every postMessage goes through toParent(), which targets PARENT_ORIGIN.
    const posts = WITHOUT_COMMENT.match(/postMessage\([^)]*\)/g) ?? []
    expect(posts).toEqual(['postMessage(msg, PARENT_ORIGIN)'])
    expect(WITHOUT_COMMENT).toContain('e.source !== window.parent || e.origin !== PARENT_ORIGIN')
  })

  it('loads CDN assets with SRI in CORS mode', () => {
    const pagedjs = WITHOUT_COMMENT.match(/<script\s+src="__PAGEDJS_POLYFILL_URL__"[^>]*>/)?.[0] ?? ''
    expect(pagedjs).toContain('integrity="__PAGEDJS_POLYFILL_SRI__"')
    expect(pagedjs).toContain('crossorigin="anonymous"')
    const katex = WITHOUT_COMMENT.match(/<link\s+rel="stylesheet"\s+href="__KATEX_CSS_URL__"[^>]*>/)?.[0] ?? ''
    expect(katex).toContain('integrity="__KATEX_CSS_SRI__"')
    expect(katex).toContain('crossorigin="anonymous"')
    // Mermaid + the highlight.js theme are injected at runtime with SRI.
    expect(WITHOUT_COMMENT).toContain('s.integrity = MERMAID_SRI')
    expect(WITHOUT_COMMENT).toContain('link.integrity = opts.hljsSri')
    expect(WITHOUT_COMMENT).not.toMatch(/\bimport\(/)
  })

  it('exposes the mount structure and the message protocol the host expects', () => {
    expect(BOOTSTRAP_HTML).toContain('id="mount"')
    expect(BOOTSTRAP_HTML).toContain('id="pending"')
    for (const type of ['iframe-ready', 'paginated', 'iframe-error', 'print-shortcut', 'print-done']) {
      expect(WITHOUT_COMMENT).toContain(`type: '${type}'`)
    }
    expect(WITHOUT_COMMENT).toContain('data.type === \'render\'')
    expect(WITHOUT_COMMENT).toContain('data.type === \'color-mode\'')
  })

  it('re-serialises mermaid SVG as XML before turning it into an <img>', () => {
    // Mermaid 11 emits HTML `<br>` inside foreignObject labels; an SVG
    // data: <img> is parsed as XML, so without this a multi-line label
    // breaks the whole diagram. Mirrors toWellFormedSvg in
    // app/utils/mermaidLoader.ts (covered in tests/dom/mermaidSvg.test.ts).
    expect(WITHOUT_COMMENT).toContain('new XMLSerializer().serializeToString(el)')
    expect(WITHOUT_COMMENT).toContain('var finished = finishMermaidSvg(rendered.svg, locale);')
  })

  it('renders mermaid with the theme config and inlines the SVGs only after pagination', () => {
    // Config = buildMermaidConfig(theme) (document font + colours); a
    // config can never lower the security level.
    expect(WITHOUT_COMMENT).toContain('cfg.securityLevel = \'antiscript\';')
    expect(WITHOUT_COMMENT).toContain('m.initialize(cfg);')
    // <img> during layout (atomic for paged.js), inline SVG afterwards,
    // before the pages are swapped into view.
    const inline = WITHOUT_COMMENT.indexOf('inlineMermaidSvgs(pending);')
    expect(inline).toBeGreaterThan(WITHOUT_COMMENT.indexOf('await previewer.preview('))
    expect(inline).toBeLessThan(WITHOUT_COMMENT.indexOf('mount.replaceChildren('))
    for (const field of ['mermaidConfig', 'locale']) expect(WITHOUT_COMMENT).toContain('\'' + field + '\'')
  })

  it('loads the pagination handlers right after paged.js, as a nonced inline script', () => {
    const polyfill = BOOTSTRAP_HTML.indexOf('__PAGEDJS_POLYFILL_URL__" integrity')
    const handlers = BOOTSTRAP_HTML.indexOf('<script nonce="__CSP_NONCE__">__PAGED_HANDLERS_SCRIPT__</script>')
    expect(polyfill).toBeGreaterThan(0)
    expect(handlers).toBeGreaterThan(polyfill)
  })

  it('keeps every link inside the preview (no self-navigation of the sandboxed frame)', () => {
    expect(WITHOUT_COMMENT).toContain('closest(\'a[href]\')')
    expect(WITHOUT_COMMENT).toMatch(/if \(!a\) return;\s*e\.preventDefault\(\);/)
  })
})
