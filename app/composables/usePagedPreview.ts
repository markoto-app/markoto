import type { Ref } from 'vue'
import type { DocTheme } from '~~/shared/types/theme'
import { composeFinalHtml } from '~/utils/composeFinalHtml'
import { themeImagesForDoc } from '~~/shared/utils/themeImages'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import type { CustomCssResult } from '~~/shared/types/customCss'
import { sanitizeCustomCssForRender, currentAppOrigins } from '~/utils/customCssLoader'
import {
  PREVIEW_SANDBOX,
  appIsDark,
  buildPreviewSrcdoc,
  buildRenderMessage,
  createFileTokenSource,
  currentCspNonce,
  parseFrameMessage,
  postToFrame,
  referencesDocFiles
} from '~/utils/previewFrame'

/**
 * Preview pane backed by a persistent sandboxed (opaque-origin) iframe.
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
 * The iframe has NO `allow-same-origin` (see app/utils/previewFrame.ts for
 * the isolation model): everything crosses as a validated postMessage —
 * render requests and the app's color mode go in, `iframe-ready` /
 * `paginated` / `iframe-error` / `print-shortcut` come out. The bootstrap
 * document lives in `pagedPreviewIframe.html`.
 */
export function usePagedPreview(opts: {
  html: Ref<string>
  theme: Ref<DocTheme>
  title: Ref<string>
  /** Owning document — scopes which uploads custom CSS may reference. */
  docId: Ref<string>
  container: Ref<HTMLElement | null>
  /**
   * Fired when the user presses Cmd/Ctrl+P while focus is INSIDE the
   * preview iframe. The parent's document-level handler doesn't see
   * keydowns inside an iframe — they bubble in the iframe's own
   * document — so we forward the shortcut over postMessage. Caller
   * should kick off the same export flow as the menu item.
   */
  onPrintShortcut?: () => void
  /**
   * The doc JWT (password unlock / Hocuspocus token) for viewers without a
   * session — used to fetch the image `file-access` token. Optional:
   * signed-in viewers are authorised by their cookie.
   */
  getDocJwt?: () => Promise<string | null>
}) {
  const pageCount = ref(0)
  const isPaginating = ref(false)
  const isReady = ref(false)
  const error = ref<string | null>(null)

  let iframe: HTMLIFrameElement | null = null
  // If a render is requested before the iframe is ready OR while a
  // previous render is still in flight, queue it. Only the latest
  // pending render matters — earlier ones are coalesced.
  //
  // Why we serialize despite the iframe-side `mount` ⇆ `pending` swap:
  // paged.js's `previewer.preview(...)` is async and renders INTO
  // `#pending`. If a second render fires before the first's
  // `replaceChildren` swap completes, the second clears pending mid-
  // render-of-the-first AND begins its own preview. Whichever swap
  // runs last races against an empty pending, leaving `#mount` empty
  // even though both renders "succeeded". The user sees an empty
  // preview pane (and screenshots / `.pagedjs_page` waits time out).
  // Tracking this with `isPaginating` + a pendingRender flag confines
  // any one in-flight render to one and only one swap.
  let pendingRender = false

  function handleMessage(e: MessageEvent) {
    const data = parseFrameMessage(e, iframe?.contentWindow)
    if (!data) return
    if (data.type === 'iframe-ready') {
      isReady.value = true
      error.value = null
      sendColorMode()
      if (pendingRender) {
        pendingRender = false
        render()
      }
    } else if (data.type === 'paginated') {
      pageCount.value = data.pageCount
      isPaginating.value = false
      // Drain any render request that arrived while we were busy.
      if (pendingRender) {
        pendingRender = false
        render()
      }
    } else if (data.type === 'iframe-error') {
      error.value = data.message || 'Preview failed to load.'
      isPaginating.value = false
      if (pendingRender) {
        pendingRender = false
        render()
      }
    } else if (data.type === 'print-shortcut') {
      opts.onPrintShortcut?.()
    }
  }

  // i18n at composable scope so themeCss can carry the localized
  // TOC heading text. Using a stub if i18n isn't installed (tests).
  const i18n = (typeof useI18n === 'function') ? useI18n() : null
  const tocTitle = computed(() => i18n?.t('table.tocTitle') ?? 'Table of Contents')

  // Sanitized custom CSS, keyed by the (docId, raw css) it was made from.
  // The sanitizer is loaded lazily, so `render()` (synchronous, because
  // of the pagination serialisation above) never awaits it: when the
  // cache is stale it kicks off the sanitize and re-enters `render()`
  // once the result is in. Documents without custom CSS skip all this.
  let customCssKey = ''
  let customCss: CustomCssResult | undefined
  let customCssPending: string | null = null

  /** True when the cache matches the current theme; otherwise starts a refresh. */
  function customCssReady(): boolean {
    const raw = opts.theme.value.customCss ?? ''
    const key = `${opts.docId.value}\n${raw}`
    if (key === customCssKey) return true
    if (raw.trim() === '') {
      customCss = undefined
      customCssKey = key
      customCssPending = null
      return true
    }
    if (customCssPending === key) return false
    customCssPending = key
    let result: CustomCssResult | undefined
    sanitizeCustomCssForRender(raw, { docId: opts.docId.value, allowedOrigins: currentAppOrigins() })
      .then((res) => {
        result = res
      })
      .catch((err: unknown) => {
        // Fail closed: no custom CSS rather than unsanitized CSS.
        console.warn('[custom css] sanitizer failed to load', err)
      })
      .finally(() => {
        // A newer edit superseded this one; its own run will render.
        if (customCssPending !== key) return
        customCss = result
        customCssPending = null
        customCssKey = key
        render()
      })
    return false
  }

  // Image access token for the opaque-origin iframe (its requests carry
  // no cookie). Same lazy pattern as the custom CSS: `render()` stays
  // synchronous and re-enters once a fresh token is in.
  const fileTokens = createFileTokenSource(() => opts.docId.value, opts.getDocJwt)
  let fileTokenPending = false

  /** True when no token is needed or a fresh one is cached; otherwise starts a refresh. */
  function fileTokenReady(html: string, themeCss: string): boolean {
    const docId = opts.docId.value
    if (!referencesDocFiles(html, docId) && !referencesDocFiles(themeCss, docId)) return true
    if (fileTokens.current() !== null) return true
    if (!fileTokenPending) {
      fileTokenPending = true
      fileTokens.refresh().finally(() => {
        fileTokenPending = false
        render()
      })
    }
    return false
  }

  function render() {
    if (!customCssReady()) return
    const frame = iframe?.contentWindow
    if (!isReady.value || !frame) {
      pendingRender = true
      return
    }
    // Serialize against in-flight pagination — concurrent renders race
    // the `#pending` ⇆ `#mount` swap inside the iframe and can land an
    // empty `#mount`. The 'paginated' / 'iframe-error' handlers drain
    // `pendingRender` once the current run terminates.
    if (isPaginating.value) {
      pendingRender = true
      return
    }
    // Re-validated at render time: the theme may have arrived over Y.js.
    // Invalid → default theme; image URLs that don't belong to this
    // document are dropped.
    const current = opts.theme.value
    const theme = themeImagesForDoc(isValidTheme(current) ? current : defaultTheme, opts.docId.value).theme
    // Compose the final HTML through the shared helper so live preview,
    // browser print, and the server-rendered PDF stay byte-identical
    // (one place to change cover/dropcap composition order).
    const html = composeFinalHtml({
      theme,
      title: opts.title.value || '',
      dateIso: new Date().toISOString().slice(0, 10),
      bodyHtml: opts.html.value
    })
    // Cheap pre-check for own-image references (header/footer images +
    // custom CSS live in the theme CSS); the message below carries the
    // fully built CSS.
    const cssProbe = `${theme.header.imageUrl} ${theme.footer.imageUrl} ${theme.brand.logoUrl} ${customCss?.css ?? ''}`
    if (!fileTokenReady(html, cssProbe)) return
    isPaginating.value = true
    postToFrame(frame, buildRenderMessage({
      html,
      theme,
      title: opts.title.value || '',
      tocTitle: tocTitle.value,
      customCss,
      docId: opts.docId.value,
      fileToken: fileTokens.current() ?? '',
      print: false
    }))
  }

  /** Mirror the app's color mode into the iframe (it can't read the parent DOM). */
  function sendColorMode() {
    const frame = iframe?.contentWindow
    if (frame && isReady.value) postToFrame(frame, { type: 'color-mode', dark: appIsDark() })
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
  useEventListener(globalThis, 'message', handleMessage)

  // The iframe used to observe the parent's <html class> itself; with an
  // opaque origin it can't, so the parent forwards every change.
  useMutationObserver(
    () => (import.meta.client ? document.documentElement : null),
    sendColorMode,
    { attributes: true, attributeFilter: ['class'] }
  )

  onMounted(() => {
    if (!opts.container.value) return
    iframe = document.createElement('iframe')
    iframe.title = 'Document preview'
    iframe.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: transparent;'
    // Sandbox: scripts only. NO allow-same-origin — the preview renders
    // content any editor (or the AI) controls, and an opaque origin keeps
    // a script injection there away from the app's cookies, storage, DOM
    // and same-origin APIs. Also omitted: allow-forms, allow-popups,
    // allow-modals, allow-top-navigation — the preview must never
    // navigate the host or open windows. See docs/SECURITY-HARDENING.md.
    iframe.setAttribute('sandbox', PREVIEW_SANDBOX)
    iframe.srcdoc = buildPreviewSrcdoc({
      parentOrigin: globalThis.location.origin,
      nonce: currentCspNonce(),
      dark: appIsDark()
    })
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
