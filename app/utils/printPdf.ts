import type { DocTheme, MermaidTheme } from '~~/shared/types/theme'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/pagedjsCdn'
import { hljsThemeUrl } from '~~/shared/utils/hljsCdn'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/katexCdn'
import { MERMAID_ESM_URL } from '~~/shared/utils/mermaidCdn'
import { renderMarkdown } from '~/utils/renderMarkdown'
import { composeFinalHtml } from '~~/shared/utils/composeFinalHtml'
import { sanitizeCustomCssForRender, currentAppOrigins } from './customCssLoader'

/**
 * Mermaid singleton in the parent document context for the print path.
 * The live preview iframe loads its own copy (different window object,
 * different module instance) — sharing here would cross document
 * boundaries which mermaid doesn't support cleanly.
 *
 * Pre-processing here (parent context) instead of inside the print
 * iframe keeps the iframe boot simpler — it gets HTML with SVGs already
 * inlined and paged.js sees plain inline SVG it can paginate normally.
 */
// Mermaid's ESM bundle is loaded via a CDN URL at runtime, so there's no
// local type to import. We only touch `initialize` and `render` — a minimal
// stub keeps this `any`-free.
interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidModule> | null = null
async function loadMermaid(theme: MermaidTheme): Promise<MermaidModule> {
  // NOTE: dynamic import() does not currently support SRI in any browser.
  // MERMAID_ESM_SRI is exported from shared/utils/mermaidCdn.ts for
  // documentation + future use (import-maps-with-integrity proposal) but
  // cannot be enforced here. Mermaid is the only CDN load in the app
  // where SRI is best-effort; paged.js + KaTeX are SRI-enforced.
  mermaidPromise ??= import(/* @vite-ignore */ MERMAID_ESM_URL)
    .then(mod => mod.default)
    .catch((err) => {
      mermaidPromise = null
      throw err
    })
  const m = await mermaidPromise
  m.initialize({
    startOnLoad: false,
    theme,
    // 'antiscript' (NOT 'strict') — see pagedPreviewIframe.html for the
    // rationale: 'strict' runs DOMPurify over the SVG which strips
    // mermaid's embedded <style>, breaking node fills + label widths.
    securityLevel: 'antiscript',
    // Match the live preview iframe (see pagedPreviewIframe.html) — see
    // that file for the rationale on font size + htmlLabels: false.
    themeVariables: { fontSize: '12px' },
    flowchart: { htmlLabels: false, padding: 25 },
    fontFamily: 'inherit'
  })
  return m
}

async function transformMermaid(html: string, theme: MermaidTheme): Promise<string> {
  if (!html.includes('language-mermaid')) return html
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks = Array.from(doc.querySelectorAll('pre code.language-mermaid'))
  if (blocks.length === 0) return html
  const m = await loadMermaid(theme)
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    await replaceMermaidBlock(doc, pre, code.textContent || '', m)
  }
  return doc.body.innerHTML
}

/**
 * Render one mermaid source string and swap the originating `<pre>` for
 * either an `<img>` wrapper (success) or an error placeholder
 * (mermaid threw). Mutates `doc` in place; no return value.
 *
 * Why an `<img>` wrapper rather than the inline SVG: paged.js fragments
 * inline SVGs across page breaks regardless of `break-inside: avoid`,
 * but an `<img>` is atomic. Same approach as `pagedPreviewIframe.html`.
 */
async function replaceMermaidBlock(doc: Document, pre: Element, source: string, m: MermaidModule): Promise<void> {
  // crypto.randomUUID() is secure-context-only. This client-side path runs
  // in the HTTPS app so it's available today, but guard it anyway — a
  // self-hosted deploy served over plain HTTP would otherwise throw here.
  // The fallback uses crypto.getRandomValues, which — unlike randomUUID —
  // is defined in non-secure contexts too. The id only needs to be unique
  // within this render pass.
  const id = 'mmd-' + (globalThis.crypto.randomUUID?.()
    ?? (Date.now().toString(36) + Array.from(
      globalThis.crypto.getRandomValues(new Uint32Array(2)),
      n => n.toString(36)
    ).join('')))
  try {
    const { svg } = await m.render(id, source)
    const { natW, natH } = extractMermaidNaturalSize(svg)
    const finalSvg = natH ? svg.replace(/<svg(\b)/, `<svg height="${natH}"$1`) : svg
    pre.replaceWith(buildMermaidImg(doc, finalSvg, natW, natH))
  } catch (err: unknown) {
    const errEl = doc.createElement('div')
    errEl.className = 'mermaid-error'
    errEl.textContent = `Mermaid error: ${err instanceof Error ? err.message : 'invalid diagram'}`
    pre.replaceWith(errEl)
  }
}

/**
 * Pull natural width + height from the mermaid SVG's `viewBox` attribute
 * (`minX minY width height`). Both fall back to null when the viewBox
 * is missing or malformed; callers omit the attribute in that case.
 */
function extractMermaidNaturalSize(svg: string): { natW: number | null, natH: number | null } {
  const vbNums = (/viewBox="[^"]*"/.exec(svg) ?? [''])[0].match(/[\d.]+/g)
  return {
    natW: vbNums?.[2] ? Math.round(Number.parseFloat(vbNums[2])) : null,
    natH: vbNums?.[3] ? Math.round(Number.parseFloat(vbNums[3])) : null
  }
}

/**
 * Encode UTF-8 text to base64. The naive `btoa(unescape(encodeURIComponent(s)))`
 * pattern uses the deprecated `unescape`. Iterate the encoded bytes in
 * 0x8000-byte chunks so very large inputs don't blow the call-stack
 * (the same pattern the audio helpers use).
 */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Wrap a rendered mermaid SVG into the data-URI `<img>` shell paged.js can paginate atomically. */
function buildMermaidImg(doc: Document, svg: string, natW: number | null, natH: number | null): HTMLElement {
  const wrap = doc.createElement('div')
  wrap.className = 'mermaid'
  const svgBase64 = utf8ToBase64(svg)
  const img = doc.createElement('img')
  img.src = `data:image/svg+xml;base64,${svgBase64}`
  img.style.cssText = 'max-width:100%;display:block;'
  if (natW) img.setAttribute('width', String(natW))
  if (natH) img.setAttribute('height', String(natH))
  wrap.appendChild(img)
  return wrap
}

/**
 * Generate a PDF of the document by:
 *   1. Rendering markdown → HTML through the same pipeline the live preview
 *      uses (renderMarkdown, with markdown-it + DOMPurify).
 *   2. Mounting that HTML into a hidden iframe with the theme CSS.
 *   3. Loading paged.js's polyfill into the iframe so it paginates with the
 *      same rules as the live preview.
 *   4. Triggering the iframe's print() — the user's browser print dialog
 *      offers "Save as PDF". After they save (or cancel), we tear down.
 *
 * Why a hidden iframe instead of printing the live preview directly: it
 * isolates the print flow from the editor chrome (toolbars, sidebars,
 * read-only banners), guarantees we paginate the canonical content
 * regardless of view-mode state, and avoids re-running pagination on the
 * live container right when the user wants to look at it. The "extra"
 * paginate is the cost of correctness.
 */
type IwinWithPaged = Window & { PagedConfig?: { auto: boolean, after: () => void } }

/**
 * Open the browser's print dialog and wire afterprint → cleanup +
 * resolve. Extracted so the call site doesn't nest 4+ arrow
 * functions inside `PagedConfig.after`.
 */
function triggerPrint(
  iwin: IwinWithPaged,
  timeoutId: ReturnType<typeof setTimeout>,
  cleanup: () => void,
  resolve: () => void,
  reject: (e: unknown) => void
): void {
  iwin.addEventListener('afterprint', () => {
    globalThis.clearTimeout(timeoutId)
    cleanup()
    resolve()
  }, { once: true })
  try {
    iwin.focus()
    iwin.print()
  } catch (e) {
    globalThis.clearTimeout(timeoutId)
    cleanup()
    reject(e)
  }
}

export async function printDocumentAsPdf(opts: {
  source: string
  theme: DocTheme
  title: string
  /** Owning document — custom CSS may only reference this doc's uploads. */
  docId: string
  tocTitle?: string
}): Promise<void> {
  const rawHtml = await renderMarkdown(opts.source)
  // Replace any mermaid code blocks with their rendered SVG BEFORE the
  // iframe builds — paged.js then paginates plain inline SVG.
  const bodyHtml = await transformMermaid(rawHtml, opts.theme.mermaid.theme)
  // Cover + drop-cap composition matches the live preview pipeline via
  // the shared helper. See `shared/utils/composeFinalHtml.ts`.
  const html = composeFinalHtml({
    theme: opts.theme,
    title: opts.title || '',
    dateIso: new Date().toISOString().slice(0, 10),
    bodyHtml
  })
  // Same render-time sanitize as the live preview (Y.js writes bypass
  // the server-side check, so the stored CSS is never trusted as-is).
  const customCss = await sanitizeCustomCssForRender(opts.theme.customCss, {
    docId: opts.docId,
    allowedOrigins: currentAppOrigins()
  })
  const themeCss = themeToCss(opts.theme, {
    title: opts.title || '',
    date: new Date().toISOString().slice(0, 10),
    tocTitle: opts.tocTitle || 'Table of Contents',
    customCss
  })
  const fontsImport = themeFontsImport(opts.theme)

  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    // Sandbox: paged.js + the polyfill need to run (allow-scripts) and
    // the iframe writes through `iframe.contentDocument` from the parent
    // (allow-same-origin). allow-modals lets `window.print()` open the
    // browser's print dialog — without it the print() call no-ops in
    // Chromium under sandbox. NO allow-top-navigation / allow-popups —
    // the print path should never navigate the host. See
    // docs/SECURITY-HARDENING.md.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals')
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;'
    document.body.appendChild(iframe)

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      try {
        iframe.remove()
      } catch { /* already gone */ }
    }

    // Safety timeout — if pagination hangs (unloadable font, runaway
    // layout) we don't want a stale iframe stuck off-screen forever.
    const timeoutId = globalThis.setTimeout(() => {
      cleanup()
      reject(new Error('PDF generation timed out after 30s'))
    }, 30000)

    try {
      const idoc = iframe.contentDocument
      // The iframe window gets a `PagedConfig` property attached before the
      // paged.js polyfill script runs — the polyfill picks it up to drive
      // the print flow. Typed inline rather than polluting a d.ts.
      const iwin: IwinWithPaged | null = iframe.contentWindow
      if (!idoc || !iwin) {
        throw new Error('Could not access iframe document')
      }

      // Initialize the iframe document. About:blank inherits the parent
      // origin so /api/* fetches (e.g. resolved image URLs) don't trip CORS.
      // Setting fields on the existing about:blank document avoids the
      // deprecated `document.write` API.
      idoc.documentElement.lang = 'en'
      if (!idoc.head.querySelector('meta[charset]')) {
        const charsetMeta = idoc.createElement('meta')
        charsetMeta.setAttribute('charset', 'UTF-8')
        idoc.head.prepend(charsetMeta)
      }
      idoc.title = opts.title

      const style = idoc.createElement('style')
      style.textContent = `${fontsImport}\n${themeCss}`
      idoc.head.appendChild(style)

      // Highlight.js theme — same CDN-loaded pattern as the live preview
      // iframe (see usePagedPreview.ts and shared/utils/hljsCdn.ts).
      // Variant follows the doc theme's `code.theme`; 'none' skips
      // the link entirely so plain monospace renders.
      const hljsUrl = hljsThemeUrl(opts.theme.code.theme)
      if (hljsUrl) {
        const hljsLink = idoc.createElement('link')
        hljsLink.rel = 'stylesheet'
        hljsLink.href = hljsUrl
        // No SRI on hljs theme stylesheets — see shared/utils/hljsCdn.ts
        // for the rationale (~30+ themes, low blast radius inside the
        // iframe, intentional tradeoff documented there).
        idoc.head.appendChild(hljsLink)
      }

      // KaTeX stylesheet — static across themes. Same CDN pattern as hljs,
      // but SRI-locked: the URL is fixed and the bytes are byte-stable so
      // we can attach an integrity hash. crossorigin="anonymous" is required
      // for SRI on cross-origin (jsdelivr) responses.
      const katexLink = idoc.createElement('link')
      katexLink.rel = 'stylesheet'
      katexLink.href = KATEX_CSS_URL
      katexLink.integrity = KATEX_CSS_SRI
      katexLink.crossOrigin = 'anonymous'
      idoc.head.appendChild(katexLink)

      const root = idoc.createElement('div')
      root.className = 'paged-doc'
      root.innerHTML = html
      idoc.body.appendChild(root)

      // PagedConfig must be set BEFORE the polyfill script runs. The polyfill
      // reads `window.PagedConfig` on DOMContentLoaded; if `auto` is true it
      // paginates the body and calls `after()` when done.
      const onPaginated = () => {
        // Wait one rAF for layout to settle, then print. afterprint fires
        // whether the user saved or cancelled — cleanup either way.
        iwin.requestAnimationFrame(() => triggerPrint(iwin, timeoutId, cleanup, resolve, reject))
      }
      iwin.PagedConfig = { auto: true, after: onPaginated }

      // Polyfill loaded from jsdelivr CDN — versioned URL handles cache
      // busting on upgrade, and the PWA service worker caches
      // cdn.jsdelivr.net so subsequent prints work offline. The iframe
      // needs its own paged.js instance: passing the parent's Previewer
      // cross-window mixes document references and breaks layout.
      // SRI-locked + crossorigin="anonymous" so a poisoned jsdelivr
      // response cannot inject JS into the print path.
      const script = idoc.createElement('script')
      script.src = PAGEDJS_POLYFILL_URL
      script.integrity = PAGEDJS_POLYFILL_SRI
      script.crossOrigin = 'anonymous'
      script.onerror = () => {
        globalThis.clearTimeout(timeoutId)
        cleanup()
        reject(new Error('Failed to load paged.js polyfill from CDN.'))
      }
      idoc.body.appendChild(script)
    } catch (e) {
      globalThis.clearTimeout(timeoutId)
      cleanup()
      reject(e)
    }
  })
}
