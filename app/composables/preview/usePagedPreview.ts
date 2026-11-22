import type { Ref } from 'vue'
import type { DocTheme } from '~~/shared/types/theme'
import { composeFinalHtml } from '~/utils/preview/composeFinalHtml'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { documentTexts } from '~~/shared/utils/documents/documentLocale'
import type { BrandFont } from '~~/shared/config/brandKit'
import { createCustomCssCache, createFileTokenGate } from './previewRenderInputs'
import type { PreviewZoomCommand } from '~/composables/preview/usePreviewZoom'
import type { CitationInputs, ReferenceProblem } from '~/utils/markdown/citationResolve'
import {
  PREVIEW_SANDBOX,
  appIsDark,
  buildZoomMessage,
  buildPreviewSrcdoc,
  buildRenderMessage,
  currentCspNonce,
  parseFrameMessage,
  mayReferenceOwnUploads,
  postToFrame,
  buildScrollToHeadingMessage
} from '~/utils/preview/previewFrame'

/**
 * Preview pane backed by a persistent sandboxed (opaque-origin) iframe.
 *
 * Why an iframe instead of rendering paged.js into the host page: paged.js
 * assumes it owns the document. It appends `<style>` elements to
 * `document.head`, sets `:root` custom properties and re-paginates the
 * whole document on every call, so re-running it in one window per
 * keystroke lets each new stylesheet restyle the old pages still on screen
 * (visible reflow, accumulating styles, horizontal jitter). In its own
 * iframe every head mutation, `:root` variable and reflow stays scoped to
 * the frame and the parent app is insulated.
 *
 * The iframe has NO `allow-same-origin` (see app/utils/preview/previewFrame.ts for
 * the isolation model): everything crosses as a validated postMessage,
 * render requests and the app's color mode go in, `iframe-ready` /
 * `paginated` / `iframe-error` / `print-shortcut` come out. The bootstrap
 * document lives in `pagedPreviewIframe.html`.
 */
export interface PagedPreviewOptions {
  html: Ref<string>
  theme: Ref<DocTheme>
  title: Ref<string>
  /**
   * Document language (`ymeta.language`). Cover date, `{date}` token, TOC
   * title and chart number formats follow it (`documentTexts`).
   */
  language?: Ref<string>
  /** Owning document: scopes which uploads custom CSS may reference.
   *  '' = no document (marketing `::try-it`): no file token is fetched. */
  docId: Ref<string>
  container: Ref<HTMLElement | null>
  /** The workspace's brand-kit fonts; none outside a workspace. */
  brandFonts?: Ref<readonly BrandFont[] | null>
  /** The document's bibliography and citation style; none = citations stay unresolved markers. */
  citations?: Ref<CitationInputs | null>
  /** Unknown citation keys / labels after each render (the editor's warning list). */
  onReferenceProblems?: (problems: ReferenceProblem[]) => void
  /**
   * Fired when the user presses Cmd/Ctrl+P while focus is INSIDE the
   * preview iframe. The parent's document-level handler doesn't see
   * keydowns inside an iframe, they bubble in the iframe's own
   * document: so we forward the shortcut over postMessage. Caller
   * should kick off the same export flow as the menu item.
   */
  onPrintShortcut?: () => void
  /**
   * The doc JWT (password unlock / Hocuspocus token) for viewers without a
   * session: used to fetch the image `file-access` token. Optional:
   * signed-in viewers are authorised by their cookie.
   */
  getDocJwt?: () => Promise<string | null>
  /**
   * Preview zoom (`usePreviewZoom`): the latest command is sent to the
   * frame whenever it changes and again when the frame (re)loads. Zoom is
   * applied inside the frame to the paginated pages, it never triggers a
   * render.
   */
  zoom?: {
    command: Ref<PreviewZoomCommand>
    /** Ctrl/Cmd +/-/0 pressed or an overview page clicked inside the frame. */
    onRequest: (action: 'in' | 'out' | 'reset' | 'page', page: number) => void
    /** A pinch / Ctrl+wheel inside the frame ended at this factor. */
    onGesture: (scale: number) => void
    /** The frame applied a zoom (effective + fit-width factor). */
    onApplied: (scale: number, fitScale: number) => void
  }
}

export function usePagedPreview(opts: PagedPreviewOptions) {
  const { t } = useI18n()
  const pageCount = ref(0)
  const isPaginating = ref(false)
  const isReady = ref(false)
  const error = ref<string | null>(null)

  let iframe: HTMLIFrameElement | null = null
  // A render requested before the iframe is ready or while another is in
  // flight is queued; only the latest matters, earlier ones coalesce.
  //
  // Serialising is required despite the iframe-side `mount` / `pending`
  // swap: paged.js's async `previewer.preview(...)` renders INTO
  // `#pending`, so a second render firing before the first's
  // `replaceChildren` swap clears `#pending` mid-render and the last swap
  // can leave `#mount` empty even though both renders "succeeded".
  let pendingRender = false

  /** Run the render that was requested while the frame was busy or loading. */
  function drainPendingRender() {
    if (pendingRender) {
      pendingRender = false
      render()
    }
  }

  function handleMessage(e: MessageEvent) {
    const data = parseFrameMessage(e, iframe?.contentWindow)
    if (!data) return
    if (data.type === 'iframe-ready') {
      isReady.value = true
      error.value = null
      sendColorMode()
      sendZoom(false)
      drainPendingRender()
    } else if (data.type === 'paginated') {
      pageCount.value = data.pageCount
      isPaginating.value = false
      // Drain a render request that arrived while busy.
      drainPendingRender()
    } else if (data.type === 'iframe-error') {
      // The iframe's message is English and technical: show the translated
      // one, keep the detail in the console.
      if (data.message) console.warn('[preview]', data.message)
      error.value = t('editor.previewFailed')
      isPaginating.value = false
      drainPendingRender()
    } else if (data.type === 'print-shortcut') {
      opts.onPrintShortcut?.()
    } else if (data.type === 'zoom-request') {
      opts.zoom?.onRequest(data.action, data.page)
    } else if (data.type === 'zoom-gesture') {
      opts.zoom?.onGesture(data.scale)
    } else if (data.type === 'zoom-state') {
      opts.zoom?.onApplied(data.scale, data.fitScale)
    }
  }

  /** Post the current zoom command (`animate` false on frame load). */
  function sendZoom(animate: boolean) {
    const frame = iframe?.contentWindow
    const cmd = opts.zoom?.command.value
    if (!frame || !isReady.value || !cmd) return
    const s = cmd.setting
    postToFrame(frame, buildZoomMessage({
      mode: s.mode,
      scale: s.mode === 'scale' ? s.scale : undefined,
      animate: animate && cmd.animate,
      // A frame (re)load starts at the reading position, not a stale page jump.
      page: animate ? cmd.page : 0
    }))
  }

  // Rendering waits for these two; each calls `render()` again once it is in.
  const fileTokens = createFileTokenGate(() => opts.docId.value, opts.getDocJwt, () => render())
  const customCss = createCustomCssCache(() => opts.docId.value, () => render())

  function render() {
    const frame = iframe?.contentWindow
    if (!isReady.value || !frame) {
      pendingRender = true
      return
    }
    // Serialize against in-flight pagination (see `pendingRender`); the
    // 'paginated' / 'iframe-error' handlers drain it when the run ends.
    if (isPaginating.value) {
      pendingRender = true
      return
    }
    // Re-validated at render time: the theme may have arrived over Y.js.
    // Invalid → default theme; image URLs that don't belong to this
    // document are dropped.
    const current = opts.theme.value
    const docId = opts.docId.value
    const theme = themeImagesForDoc(isValidTheme(current) ? current : defaultTheme, docId).theme
    // The shared helper keeps live preview, browser print and the
    // server-rendered PDF byte-identical.
    const language = opts.language?.value ?? ''
    const html = composeFinalHtml({
      theme,
      title: opts.title.value || '',
      date: documentTexts(theme, language).date,
      bodyHtml: opts.html.value,
      language,
      citations: opts.citations?.value ?? null,
      onReferenceProblems: opts.onReferenceProblems
    })
    const rawCustomCss = theme.customCss ?? ''
    // No document (the marketing `::try-it` block): there are no uploads to
    // authorise, so never ask for a file token.
    const brandFonts = opts.brandFonts?.value ?? null
    const fileToken = fileTokens.tokenFor(docId !== '' && mayReferenceOwnUploads({ html, theme, rawCustomCss, docId, brandFonts }))
    if (fileToken === null) return
    if (!customCss.ready(rawCustomCss, fileToken)) return
    isPaginating.value = true
    postToFrame(frame, buildRenderMessage({
      html,
      theme,
      title: opts.title.value || '',
      language,
      customCss: customCss.current(),
      docId,
      fileToken,
      print: false,
      brandFonts
    }))
  }

  /** Scroll the shown pages to a heading's anchor (the editor's outline). */
  function scrollToHeading(id: string) {
    const frame = iframe?.contentWindow
    const msg = buildScrollToHeadingMessage(id)
    if (frame && isReady.value && msg) postToFrame(frame, msg)
  }

  /** Mirror the app's color mode into the iframe (it can't read the parent DOM). */
  function sendColorMode() {
    const frame = iframe?.contentWindow
    if (frame && isReady.value) postToFrame(frame, { type: 'color-mode', dark: appIsDark() })
  }

  // The iframe contains the layout cost, so a short debounce is enough.
  const debouncedRender = useDebounceFn(render, 250)

  let firstRender = true
  watch([opts.html, opts.theme, opts.title, () => opts.language?.value, () => opts.brandFonts?.value, () => opts.citations?.value], () => {
    if (firstRender) {
      firstRender = false
      render() // immediate first paint after sync
    } else {
      void debouncedRender()
    }
  })

  if (opts.zoom) {
    watch(() => opts.zoom?.command.value.seq, () => sendZoom(true))
  }

  useEventListener(globalThis, 'message', handleMessage)

  // The opaque-origin iframe can't observe the parent's <html class>, so
  // the parent forwards every change.
  useMutationObserver(
    () => (import.meta.client ? document.documentElement : null),
    sendColorMode,
    { attributes: true, attributeFilter: ['class'] }
  )

  onMounted(() => {
    if (!opts.container.value) return
    iframe = document.createElement('iframe')
    iframe.title = t('editor.previewFrameTitle')
    iframe.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: transparent;'
    // Sandbox: scripts only. NO allow-same-origin: the preview renders
    // content any editor (or the AI) controls, and an opaque origin keeps
    // a script injection there away from the app's cookies, storage, DOM
    // and same-origin APIs. Also omitted: allow-forms, allow-popups,
    // allow-modals, allow-top-navigation (the preview must never navigate
    // the host or open windows). See docs/SECURITY-HARDENING.md.
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
    error: readonly(error),
    scrollToHeading
  }
}
