import type { Ref } from 'vue'
import type { DocTheme } from '~~/shared/types/theme'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { composeFinalHtml } from '~~/shared/utils/composeFinalHtml'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsCdn'
import { hljsThemeUrl } from '~~/shared/utils/hljsCdn'
import { KATEX_CSS_URL } from '~~/shared/utils/katexCdn'
import { MERMAID_ESM_URL } from '~~/shared/utils/mermaidCdn'
// Iframe bootstrap document — lives in its own .html file so backticks
// don't need escaping and the HTML/CSS/JS gets proper syntax highlighting.
// Loaded as a raw string via Vite's `?raw` import. URL placeholders are
// substituted at mount time below.
import IFRAME_BOOTSTRAP from './pagedPreviewIframe.html?raw'

/**
 * Preview pane backed by a persistent same-origin iframe.
 *
 * Why an iframe instead of rendering paged.js directly into the host page:
 *
 *   paged.js was designed to paginate a static document once. It mutates
 *   global state — appends `<style>` elements to `document.head`, sets
 *   `:root` custom properties — and re-paginates the entire doc on every
 *   call. When you re-run paged.js into the same window on every keystroke,
 *   the new render's stylesheet retroactively re-styles the OLD pages
 *   still on screen (causing visible reflow), accumulated stylesheets pile
 *   up in head, and subpixel layout differences between renders show up
 *   as horizontal jitter on the live preview.
 *
 *   We tried six rounds of mitigations (off-screen swap, style cleanup,
 *   height pin, position-fixed, sequential queueing, adaptive debounce)
 *   and the symptom kept resurfacing in different forms. The conclusion:
 *   we were fighting paged.js's design assumption that it owns the
 *   document. The clean fix is to give it its own document context.
 *
 *   Inside an iframe, every paged.js head-style mutation, every :root
 *   var, every layout reflow stays scoped to the iframe. The parent app
 *   is fully insulated. Even the iframe's internal flicker is bounded —
 *   it's just the preview pane visibly re-rendering, which the user
 *   already expects to do during pagination.
 *
 * Communication is one-way through `iframe.contentWindow.__renderDoc(opts)`
 * (parent → iframe) and a single `postMessage` event for page count
 * (iframe → parent). The iframe initialization document lives in
 * `pagedPreviewIframe.html` — it loads the paged.js polyfill from the
 * `/api/_internal/pagedjs-polyfill.js` Nitro endpoint (same one the PDF
 * print iframe uses) and exposes the render function once `Paged.Previewer`
 * is available.
 */
export function usePagedPreview(opts: {
  html: Ref<string>
  theme: Ref<DocTheme>
  title: Ref<string>
  container: Ref<HTMLElement | null>
  /**
   * Fired when the user presses Cmd/Ctrl+P while focus is INSIDE the
   * preview iframe. The parent's document-level handler doesn't see
   * keydowns inside an iframe — they bubble in the iframe's own
   * document — so we forward the shortcut over postMessage. Caller
   * should kick off the same export flow as the menu item.
   */
  onPrintShortcut?: () => void
}) {
  const pageCount = ref(0)
  const isPaginating = ref(false)
  const isReady = ref(false)
  const error = ref<string | null>(null)

  let iframe: HTMLIFrameElement | null = null
  // If a render is requested before the iframe is ready, queue it. Only
  // the latest pending render matters — earlier ones are coalesced.
  let pendingRender = false

  function handleMessage(e: MessageEvent) {
    if (!iframe || e.source !== iframe.contentWindow) return
    const data = e.data as { type?: string, pageCount?: number, message?: string } | undefined
    if (!data?.type) return
    if (data.type === 'iframe-ready') {
      isReady.value = true
      error.value = null
      if (pendingRender) {
        pendingRender = false
        render()
      }
    } else if (data.type === 'paginated') {
      pageCount.value = data.pageCount ?? 0
      isPaginating.value = false
    } else if (data.type === 'iframe-error') {
      error.value = data.message ?? 'Preview failed to load.'
      isPaginating.value = false
    } else if (data.type === 'print-shortcut') {
      opts.onPrintShortcut?.()
    }
  }

  // i18n at composable scope so themeCss can carry the localized
  // TOC heading text. Using a stub if i18n isn't installed (tests).
  const i18n = (typeof useI18n === 'function') ? useI18n() : null
  const tocTitle = computed(() => i18n?.t('table.tocTitle') ?? 'Table of Contents')

  function render() {
    if (!isReady.value || !iframe?.contentWindow) {
      pendingRender = true
      return
    }
    const themeCss = themeToCss(opts.theme.value, {
      title: opts.title.value || '',
      date: new Date().toISOString().slice(0, 10),
      tocTitle: tocTitle.value
    })
    const fontsImport = themeFontsImport(opts.theme.value)
    const hljsUrl = hljsThemeUrl(opts.theme.value.code.theme)
    const mermaidTheme = opts.theme.value.mermaid.theme
    // Compose the final HTML through the shared helper so live preview,
    // browser print, and the server-rendered PDF stay byte-identical
    // (one place to change cover/dropcap composition order).
    const html = composeFinalHtml({
      theme: opts.theme.value,
      title: opts.title.value || '',
      dateIso: new Date().toISOString().slice(0, 10),
      bodyHtml: opts.html.value
    })
    isPaginating.value = true
    ;(iframe.contentWindow as unknown as { __renderDoc: (o: unknown) => void }).__renderDoc({
      html,
      themeCss,
      fontsImport,
      hljsUrl,
      mermaidTheme
    })
  }

  // 250ms debounce. Lower than the previous 800ms because the iframe
  // contains the layout cost — re-paginates don't cause cross-contamination
  // and there's no off-screen-swap dance to amortize. Could probably go
  // lower; tune based on user feel.
  const debouncedRender = useDebounceFn(render, 250)

  let firstRender = true
  watch([opts.html, opts.theme, opts.title], () => {
    if (firstRender) {
      firstRender = false
      render() // immediate first paint after sync
    } else {
      debouncedRender()
    }
  })

  // useEventListener auto-cleans on scope dispose — no manual
  // removeEventListener in onUnmounted needed.
  useEventListener(window, 'message', handleMessage)

  onMounted(() => {
    if (!opts.container.value) return
    iframe = document.createElement('iframe')
    iframe.title = 'Document preview'
    iframe.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: transparent;'
    // hljs theme is set per-render (depends on `theme.blocks.codeBlockTheme`).
    // Bootstrap leaves the link href empty; renderDoc fills it.
    // replaceAll (not replace): the HTML file's header comment names each
    // placeholder for readers, so each token appears twice — once in the
    // comment, once in the actual tag. `.replace` only substitutes the
    // first occurrence, which would leave the real `<script src>` URL
    // unreplaced and paged.js would never load.
    iframe.srcdoc = IFRAME_BOOTSTRAP
      .replaceAll('__PAGEDJS_POLYFILL_URL__', PAGEDJS_POLYFILL_URL)
      .replaceAll('__KATEX_CSS_URL__', KATEX_CSS_URL)
      .replaceAll('__MERMAID_ESM_URL__', MERMAID_ESM_URL)
    opts.container.value.appendChild(iframe)
  })

  onUnmounted(() => {
    if (iframe?.parentNode) iframe.remove()
    iframe = null
  })

  return {
    pageCount: readonly(pageCount),
    isPaginating: readonly(isPaginating),
    isReady: readonly(isReady),
    error: readonly(error)
  }
}
