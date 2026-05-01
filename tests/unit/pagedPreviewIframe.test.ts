import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/pagedjsCdn'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/katexCdn'
import { MERMAID_ESM_URL } from '~~/shared/utils/mermaidCdn'

// Guards the placeholder-substitution contract between pagedPreviewIframe.html
// and usePagedPreview.ts. The file's header comment names each placeholder
// token for readers, which puts every token in the string twice — once in the
// comment, once at its real usage site. A plain `.replace()` only substitutes
// the first occurrence (the comment) and would leave paged.js's <script src>
// unresolved. This suite would have caught the initial bug where the refactor
// shipped with `.replace` instead of `.replaceAll`.
//
// Loaded via readFileSync (not `?raw`) so this stays in the `unit` project
// which runs without Vite's transform pipeline.
const BOOTSTRAP_HTML = readFileSync(
  fileURLToPath(new URL('../../app/composables/pagedPreviewIframe.html', import.meta.url)),
  'utf8'
)

function substitute(source: string): string {
  return source
    .replaceAll('__PAGEDJS_POLYFILL_URL__', PAGEDJS_POLYFILL_URL)
    .replaceAll('__PAGEDJS_POLYFILL_SRI__', PAGEDJS_POLYFILL_SRI)
    .replaceAll('__KATEX_CSS_URL__', KATEX_CSS_URL)
    .replaceAll('__KATEX_CSS_SRI__', KATEX_CSS_SRI)
    .replaceAll('__MERMAID_ESM_URL__', MERMAID_ESM_URL)
}

describe('pagedPreviewIframe.html', () => {
  it('contains each placeholder at a real usage site (not only in the comment)', () => {
    // Strip the leading HTML comment block and assert each token still
    // appears — proves the placeholder lives in an actual `src`/`href`/
    // `import()` position, not just in documentation.
    const withoutComment = BOOTSTRAP_HTML.replace(/<!--[\s\S]*?-->/, '')
    expect(withoutComment).toContain('__PAGEDJS_POLYFILL_URL__')
    expect(withoutComment).toContain('__PAGEDJS_POLYFILL_SRI__')
    expect(withoutComment).toContain('__KATEX_CSS_URL__')
    expect(withoutComment).toContain('__KATEX_CSS_SRI__')
    expect(withoutComment).toContain('__MERMAID_ESM_URL__')
  })

  it('leaves no placeholder tokens after substitution', () => {
    const out = substitute(BOOTSTRAP_HTML)
    // Any leftover `__SOMETHING__` token means either a missing replace call
    // here or a new placeholder added to the HTML without a matching replace
    // in usePagedPreview.ts.
    expect(out).not.toMatch(/__[A-Z_]+__/)
  })

  it('wires the substituted CDN URLs into the expected tags', () => {
    const out = substitute(BOOTSTRAP_HTML)
    expect(out).toContain(`<script src="${PAGEDJS_POLYFILL_URL}"`)
    expect(out).toContain(`<link rel="stylesheet" href="${KATEX_CSS_URL}"`)
    expect(out).toContain(`import('${MERMAID_ESM_URL}')`)
  })

  it('attaches SRI + crossorigin attrs to the SRI-locked tags', () => {
    // paged.js + KaTeX must carry both `integrity=` and
    // `crossorigin="anonymous"`. Without the latter, the browser silently
    // skips SRI on cross-origin responses and ANY bytes are accepted.
    const out = substitute(BOOTSTRAP_HTML)
    expect(out).toContain(`integrity="${PAGEDJS_POLYFILL_SRI}"`)
    expect(out).toContain(`integrity="${KATEX_CSS_SRI}"`)
    // Both SRI-locked tags must be in CORS mode.
    const scriptMatch = out.match(/<script\s+src="[^"]*paged\.polyfill[^"]*"[^>]*>/)
    expect(scriptMatch?.[0]).toContain('crossorigin="anonymous"')
    const linkMatch = out.match(/<link\s+rel="stylesheet"\s+href="[^"]*katex[^"]*"[^>]*>/)
    expect(linkMatch?.[0]).toContain('crossorigin="anonymous"')
  })

  it('exposes the mount structure the composable expects', () => {
    // usePagedPreview reads `__renderDoc` off `iframe.contentWindow` and
    // relies on the #mount/#pending divs being present. These are the
    // structural contract between the HTML and the composable; if any go
    // missing, the preview silently breaks in a way that's only caught in
    // the browser.
    expect(BOOTSTRAP_HTML).toContain('id="mount"')
    expect(BOOTSTRAP_HTML).toContain('id="pending"')
    expect(BOOTSTRAP_HTML).toContain('window.__renderDoc')
    // The iframe must message `iframe-ready` back — otherwise the composable
    // queues the first render forever.
    expect(BOOTSTRAP_HTML).toContain('type: \'iframe-ready\'')
    expect(BOOTSTRAP_HTML).toContain('type: \'paginated\'')
  })
})
