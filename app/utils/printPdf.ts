import type { DocTheme } from '~~/shared/types/theme'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsCdn'
import { hljsThemeUrl } from '~~/shared/utils/hljsCdn'
import { KATEX_CSS_URL } from '~~/shared/utils/katexCdn'
import { renderMarkdown } from '~/utils/renderMarkdown'

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
export async function printDocumentAsPdf(opts: {
  source: string
  theme: DocTheme
  title: string
}): Promise<void> {
  const html = await renderMarkdown(opts.source)
  const themeCss = themeToCss(opts.theme, {
    title: opts.title || '',
    date: new Date().toISOString().slice(0, 10)
  })
  const fontsImport = themeFontsImport(opts.theme)

  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;'
    document.body.appendChild(iframe)

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      try { iframe.remove() } catch { /* already gone */ }
    }

    // Safety timeout — if pagination hangs (unloadable font, runaway
    // layout) we don't want a stale iframe stuck off-screen forever.
    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('PDF generation timed out after 30s'))
    }, 30000)

    try {
      const idoc = iframe.contentDocument
      const iwin = iframe.contentWindow as any
      if (!idoc || !iwin) {
        throw new Error('Could not access iframe document')
      }

      // Initialize the iframe document. About:blank inherits the parent
      // origin so /api/* fetches (e.g. resolved image URLs) don't trip CORS.
      idoc.open()
      idoc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        escapeHtml(opts.title) + '</title></head><body></body></html>')
      idoc.close()

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
        idoc.head.appendChild(hljsLink)
      }

      // KaTeX stylesheet — static across themes. Same CDN pattern as hljs.
      const katexLink = idoc.createElement('link')
      katexLink.rel = 'stylesheet'
      katexLink.href = KATEX_CSS_URL
      idoc.head.appendChild(katexLink)

      const root = idoc.createElement('div')
      root.className = 'paged-doc'
      root.innerHTML = html
      idoc.body.appendChild(root)

      // PagedConfig must be set BEFORE the polyfill script runs. The polyfill
      // reads `window.PagedConfig` on DOMContentLoaded; if `auto` is true it
      // paginates the body and calls `after()` when done.
      iwin.PagedConfig = {
        auto: true,
        after: () => {
          // Wait one rAF for layout to settle, then print. afterprint fires
          // whether the user saved or cancelled — cleanup either way.
          iwin.requestAnimationFrame(() => {
            iwin.addEventListener('afterprint', () => {
              window.clearTimeout(timeoutId)
              cleanup()
              resolve()
            }, { once: true })
            try {
              iwin.focus()
              iwin.print()
            } catch (e) {
              window.clearTimeout(timeoutId)
              cleanup()
              reject(e)
            }
          })
        }
      }

      // Polyfill loaded from jsdelivr CDN — versioned URL handles cache
      // busting on upgrade, and the PWA service worker caches
      // cdn.jsdelivr.net so subsequent prints work offline. The iframe
      // needs its own paged.js instance: passing the parent's Previewer
      // cross-window mixes document references and breaks layout.
      const script = idoc.createElement('script')
      script.src = PAGEDJS_POLYFILL_URL
      script.onerror = () => {
        window.clearTimeout(timeoutId)
        cleanup()
        reject(new Error('Failed to load paged.js polyfill from CDN.'))
      }
      idoc.body.appendChild(script)
    } catch (e) {
      window.clearTimeout(timeoutId)
      cleanup()
      reject(e)
    }
  })
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
