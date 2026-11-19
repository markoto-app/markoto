import type { DocTheme } from '~~/shared/types/theme'
import { renderMarkdown } from '~/utils/markdown/renderMarkdown'
import { composeFinalHtml } from '~/utils/preview/composeFinalHtml'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { documentTexts } from '~~/shared/utils/documents/documentLocale'
import { sanitizeCustomCssForRender, currentAppOrigins } from './customCssLoader'
import type { BrandFont } from '~~/shared/config/brandKit'
import type { CitationInputs } from '../markdown/citationResolve'
import {
  PRINT_SANDBOX,
  buildPreviewSrcdoc,
  buildRenderMessage,
  createFileTokenSource,
  currentCspNonce,
  parseFrameMessage,
  mayReferenceOwnUploads,
  postToFrame,
  withOwnUploadToken
} from './previewFrame'
import { MINUTE_MS } from '~~/shared/config/units'

/** Pagination must finish within this; the print dialog itself has no limit. */
const PAGINATION_TIMEOUT_MS = 30_000
/** A hidden print iframe whose `afterprint` never arrives is removed after this. */
const PRINT_IFRAME_MAX_LIFETIME_MS = 10 * MINUTE_MS

/**
 * Print the document through the browser's dialog ("Save as PDF").
 *
 *   1. Render markdown → HTML through the same pipeline as the live
 *      preview (renderMarkdown + composeFinalHtml, sanitised).
 *   2. Mount a hidden iframe running the SAME bootstrap as the live
 *      preview (`pagedPreviewIframe.html`), sandboxed `allow-scripts
 *      allow-modals`: no `allow-same-origin`, so the printed content runs
 *      in an opaque origin like the preview (see previewFrame.ts). Mermaid
 *      renders inside it, never in the app's origin.
 *   3. Post a `render` message with `print: true`; the iframe paginates
 *      with paged.js, calls `window.print()` (allow-modals) and answers
 *      `print-done` on `afterprint`: whether the user saved or cancelled.
 *
 * Why a hidden iframe instead of printing the live preview: it isolates the
 * print flow from the editor chrome, works when the preview isn't shown
 * (edit-only view, mobile), and paginates the canonical content regardless
 * of view-mode state. The bootstrap's `@media print` block strips the
 * preview chrome (surround, gaps, shadows, zoom).
 */
export async function printDocumentAsPdf(opts: {
  source: string
  theme: DocTheme
  title: string
  /** Owning document: custom CSS may only reference this doc's uploads. */
  docId: string
  /** Document language (`ymeta.language`): cover date, `{date}`, TOC title. */
  language?: string
  /** Doc JWT for session-less viewers (image access token fetch). */
  getDocJwt?: () => Promise<string | null>
  /** The workspace's brand-kit fonts. */
  brandFonts?: readonly BrandFont[] | null
  /** The document's bibliography and citation style. */
  citations?: CitationInputs | null
}): Promise<void> {
  // Re-validate the theme here: it comes from `ymeta.theme`, which any
  // editor can write over Y.js. Invalid → default theme; image URLs that
  // don't belong to this document are dropped.
  const theme = themeImagesForDoc(isValidTheme(opts.theme) ? opts.theme : defaultTheme, opts.docId).theme
  const bodyHtml = await renderMarkdown(opts.source)
  const html = composeFinalHtml({
    theme,
    title: opts.title || '',
    date: documentTexts(theme, opts.language).date,
    bodyHtml,
    language: opts.language,
    citations: opts.citations ?? null
  })
  // The opaque-origin iframe's image requests carry no cookie: the
  // document's own upload URLs get the short-lived file-access token, as
  // in the live preview.
  let fileToken = ''
  if (mayReferenceOwnUploads({ html, theme, rawCustomCss: theme.customCss, docId: opts.docId, brandFonts: opts.brandFonts })) {
    const tokens = createFileTokenSource(() => opts.docId, opts.getDocJwt)
    await tokens.refresh()
    fileToken = tokens.current() ?? ''
  }
  // Same render-time sanitize as the live preview (Y.js writes bypass
  // the server-side check, so the stored CSS is never trusted as-is).
  const docId = opts.docId
  const customCss = await sanitizeCustomCssForRender(theme.customCss, {
    docId,
    allowedOrigins: currentAppOrigins(),
    fileUrl: path => withOwnUploadToken(path, docId, fileToken)
  })
  const message = buildRenderMessage({
    html,
    theme,
    title: opts.title || '',
    language: opts.language ?? '',
    customCss,
    docId: opts.docId,
    fileToken,
    print: true,
    brandFonts: opts.brandFonts
  })

  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.title = opts.title || 'Print'
    // allow-modals lets `window.print()` open the dialog, Chromium no-ops
    // it in a sandboxed frame without the flag. No allow-same-origin, no
    // allow-top-navigation / allow-popups. See docs/SECURITY-HARDENING.md.
    iframe.setAttribute('sandbox', PRINT_SANDBOX)
    // Inside the viewport (1×1 px, transparent, click-through) rather than
    // parked off-screen: Chromium throttles rendering + rAF of OFF-SCREEN
    // cross-origin frames (this one has an opaque origin), so paged.js
    // would never finish.
    iframe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;'

    let settled = false
    let paginationTimer: ReturnType<typeof setTimeout> | null = null
    let lifetimeTimer: ReturnType<typeof setTimeout> | null = null

    function cleanup() {
      globalThis.removeEventListener('message', onMessage)
      if (paginationTimer) globalThis.clearTimeout(paginationTimer)
      if (lifetimeTimer) globalThis.clearTimeout(lifetimeTimer)
      iframe.remove()
    }
    function finish(err?: Error) {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve()
    }

    function onMessage(e: MessageEvent) {
      const msg = parseFrameMessage(e, iframe.contentWindow)
      if (!msg) return
      if (msg.type === 'iframe-ready') {
        const frame = iframe.contentWindow
        if (frame) postToFrame(frame, message)
      } else if (msg.type === 'paginated') {
        // The dialog is about to open; it may stay open as long as the
        // user likes (an out-of-process iframe doesn't block our timers).
        if (paginationTimer) globalThis.clearTimeout(paginationTimer)
        paginationTimer = null
      } else if (msg.type === 'print-done') {
        finish()
      } else if (msg.type === 'iframe-error') {
        finish(new Error(msg.message))
      }
    }

    // eslint-disable-next-line sonarjs/post-message -- onMessage checks `event.source` against the iframe's window in parseFrameMessage
    globalThis.addEventListener('message', onMessage)
    // Safety nets: pagination hanging (unloadable font, runaway layout),
    // and an `afterprint` that never arrives.
    paginationTimer = globalThis.setTimeout(() => {
      finish(new Error('PDF generation timed out after 30s'))
    }, PAGINATION_TIMEOUT_MS)
    lifetimeTimer = globalThis.setTimeout(() => finish(), PRINT_IFRAME_MAX_LIFETIME_MS)

    iframe.srcdoc = buildPreviewSrcdoc({
      parentOrigin: globalThis.location.origin,
      nonce: currentCspNonce(),
      // Print output never shows the dark surround (@media print reset).
      dark: false
    })
    document.body.appendChild(iframe)
  })
}
