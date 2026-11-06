import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/pagedjsAssets'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/katexAssets'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/mermaidAssets'
import { hljsTheme } from '~~/shared/utils/hljsAssets'
import { ownUploadFileId } from '~~/shared/utils/themeImages'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { buildMermaidConfig } from '~~/shared/utils/mermaidConfig'
import { documentTexts } from '~~/shared/utils/documentLocale'
import type { DocTheme } from '~~/shared/types/theme'
import { PAGED_HANDLERS_SCRIPT } from './pagedHandlers'
import { PREVIEW_ZOOM_SCRIPT } from './previewZoomFrame'
import type { FrameZoomMode } from './previewZoomFrame'
import type { CustomCssResult } from '~~/shared/types/customCss'
// Iframe bootstrap document — its own .html file so the HTML/CSS/JS gets
// proper syntax highlighting. Loaded as a raw string via Vite's `?raw`.
import IFRAME_BOOTSTRAP from '~/composables/pagedPreviewIframe.html?raw'

/**
 * Host side of the sandboxed paged.js iframe used by the live preview
 * (`usePagedPreview`) and the browser print path (`printPdf`).
 *
 * The iframe runs with `sandbox="allow-scripts"` (print: `+ allow-modals`)
 * and NO `allow-same-origin`, i.e. in an opaque origin. Rendered document
 * content is attacker-influenced (any editor of the doc, the AI, imports),
 * and before this split a script injection inside the preview ran with the
 * app's origin — cookies, storage, parent DOM, same-origin API calls. Now
 * the only channel between the two documents is postMessage, with:
 *
 *   - parent side: `event.source === iframe.contentWindow` AND
 *     `event.origin === 'null'` (an opaque origin serialises to "null"),
 *     then a shape check per message type (`parseFrameMessage`);
 *   - iframe side: `event.source === window.parent` AND
 *     `event.origin === <parent origin>` (baked into the srcdoc), and it
 *     posts back to that origin only.
 *
 * Consequences handled here:
 *   - the iframe can't call `__renderDoc` or read the parent's color mode,
 *     so both arrive as messages (`RenderMessage`, `ColorModeMessage`);
 *   - its `<img>` requests are cross-site and carry no session cookie, so
 *     the document's own upload URLs get a short-lived `file-access` token
 *     appended (`withOwnUploadToken` / `attachOwnUploadTokens`, minted by
 *     `GET /api/docs/:docId/file-token`) — same mechanism as the server
 *     render page;
 *   - the srcdoc inherits the app's CSP, so its inline scripts carry the
 *     page's CSP nonce (`currentCspNonce`).
 */

export type ParentToFrameMessage = RenderMessage | ColorModeMessage | ZoomMessage

export interface RenderMessage {
  type: 'render'
  html: string
  themeCss: string
  fontsImport: string
  hljsUrl: string
  hljsSri: string
  /** `JSON.stringify(buildMermaidConfig(theme))` — Mermaid's initialize config. */
  mermaidConfig: string
  /** BCP-47 document language (chart number formats). */
  locale: string
  /** Print once paginated (browser print path). */
  print: boolean
}

export interface ColorModeMessage {
  type: 'color-mode'
  dark: boolean
}

/**
 * Preview zoom (`usePreviewZoom` → the iframe's zoom engine,
 * `previewZoomFrame.ts`). Presentation only — never re-paginates.
 */
export interface ZoomMessage {
  type: 'zoom'
  mode: FrameZoomMode
  /** Factor for `mode: 'scale'` (ignored otherwise, still a valid number). */
  scale: number
  animate: boolean
  /** 1-based page to scroll to the top (overview click); 0 = keep position. */
  page: number
}

export type ZoomRequestAction = 'in' | 'out' | 'reset' | 'page'

export type FrameToParentMessage
  = | { type: 'iframe-ready' }
    | { type: 'paginated', pageCount: number }
    | { type: 'iframe-error', message: string }
    | { type: 'print-shortcut' }
    | { type: 'print-done' }
    /** Zoom the frame applied: `scale` is the effective factor, `fitScale` the fit-width one. */
    | { type: 'zoom-state', mode: FrameZoomMode, scale: number, fitScale: number }
    /** Shortcut pressed / overview page clicked inside the frame. `page` ≥ 1 only for 'page'. */
    | { type: 'zoom-request', action: ZoomRequestAction, page: number }
    /** A pinch / Ctrl+wheel ended at this factor (already applied in the frame). */
    | { type: 'zoom-gesture', scale: number }

/** `sandbox` value of the live preview iframe — deliberately no `allow-same-origin`. */
export const PREVIEW_SANDBOX = 'allow-scripts'
/** Print iframe: `allow-modals` lets `window.print()` open the dialog. */
export const PRINT_SANDBOX = 'allow-scripts allow-modals'

/**
 * Validates a message received from the iframe. Returns null for anything
 * not posted by `frame` itself (opaque origin) or not matching the protocol.
 */
export function parseFrameMessage(e: MessageEvent, frame: Window | null | undefined): FrameToParentMessage | null {
  if (!frame || e.source !== frame || e.origin !== 'null') return null
  const data: unknown = e.data
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>
  switch (msg.type) {
    case 'iframe-ready':
    case 'print-shortcut':
    case 'print-done':
      return { type: msg.type }
    case 'paginated':
      return typeof msg.pageCount === 'number' && Number.isFinite(msg.pageCount) && msg.pageCount >= 0
        ? { type: 'paginated', pageCount: Math.floor(msg.pageCount) }
        : null
    case 'iframe-error':
      return typeof msg.message === 'string'
        ? { type: 'iframe-error', message: msg.message.slice(0, 500) }
        : null
    case 'zoom-state':
      return isZoomMode(msg.mode) && isZoomFactor(msg.scale) && isZoomFactor(msg.fitScale)
        ? { type: 'zoom-state', mode: msg.mode, scale: msg.scale, fitScale: msg.fitScale }
        : null
    case 'zoom-request':
      return parseZoomRequest(msg.action, msg.page)
    case 'zoom-gesture':
      return isZoomFactor(msg.scale) ? { type: 'zoom-gesture', scale: msg.scale } : null
    default:
      return null
  }
}

function isZoomMode(v: unknown): v is FrameZoomMode {
  return v === 'fit' || v === 'scale' || v === 'overview'
}

/** A zoom factor the frame may report: finite, positive, sane. */
function isZoomFactor(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10
}

/** Upper bound for a page number (the frame can't have more pages than this). */
const MAX_PAGE = 100_000

function parseZoomRequest(action: unknown, page: unknown): FrameToParentMessage | null {
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) return null
  if (action === 'page') return page >= 1 ? { type: 'zoom-request', action, page } : null
  if (action === 'in' || action === 'out' || action === 'reset') return { type: 'zoom-request', action, page: 0 }
  return null
}

/** The zoom message for a setting (`scale` is only meaningful in 'scale' mode). */
export function buildZoomMessage(opts: { mode: FrameZoomMode, scale?: number, animate: boolean, page?: number }): ZoomMessage {
  const scale = opts.mode === 'scale' && opts.scale !== undefined && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1
  const page = opts.page !== undefined && Number.isInteger(opts.page) && opts.page > 0 ? opts.page : 0
  return { type: 'zoom', mode: opts.mode, scale, animate: opts.animate, page }
}

/** Post a protocol message to the iframe. Its origin is opaque, hence '*'. */
export function postToFrame(frame: Window, msg: ParentToFrameMessage): void {
  frame.postMessage(msg, '*')
}

/**
 * The CSP nonce of the current page (set per response by the server —
 * server/plugins/csp.ts). The srcdoc inherits the page's CSP, so its
 * inline scripts must carry the same nonce. Browsers hide the `nonce`
 * attribute after parsing but keep the `nonce` property. Empty when the
 * page has no CSP (dev server).
 */
export function currentCspNonce(doc: Document = document): string {
  for (const el of Array.from(doc.querySelectorAll('script'))) {
    if (el.nonce) return el.nonce
  }
  return ''
}

/** srcdoc of the preview / print iframe with every placeholder substituted. */
export function buildPreviewSrcdoc(opts: { parentOrigin: string, nonce: string, dark: boolean }): string {
  // replaceAll: the bootstrap's header comment names some placeholders too.
  return IFRAME_BOOTSTRAP
    .replaceAll('__CSP_NONCE__', attrSafe(opts.nonce))
    .replaceAll('__PARENT_ORIGIN__', jsStringSafe(opts.parentOrigin))
    .replaceAll('__INITIAL_DARK__', opts.dark ? 'true' : 'false')
    .replaceAll('__PAGEDJS_POLYFILL_URL__', PAGEDJS_POLYFILL_URL)
    .replaceAll('__PAGEDJS_POLYFILL_SRI__', PAGEDJS_POLYFILL_SRI)
    .replaceAll('__KATEX_CSS_URL__', KATEX_CSS_URL)
    .replaceAll('__KATEX_CSS_SRI__', KATEX_CSS_SRI)
    .replaceAll('__MERMAID_URL__', MERMAID_URL)
    .replaceAll('__MERMAID_SRI__', MERMAID_SRI)
    // A function replacer: the script source must not be read as a
    // replacement pattern (`$&`, `$1`, …).
    .replaceAll('__PAGED_HANDLERS_SCRIPT__', () => pagedHandlersInline())
    .replaceAll('__PREVIEW_ZOOM_SCRIPT__', () => previewZoomInline())
}

/** previewZoomFrame.ts function source for the bootstrap script (never closes the tag). */
function previewZoomInline(): string {
  return PREVIEW_ZOOM_SCRIPT.replaceAll(/<\/(script)/gi, String.raw`<\/$1`)
}

/** pagedHandlers.ts source as an inline-script body (never closes the tag). */
function pagedHandlersInline(): string {
  return PAGED_HANDLERS_SCRIPT.replaceAll(/<\/(script)/gi, String.raw`<\/$1`)
}

/** Nonces are base64; anything else is dropped rather than escaped. */
function attrSafe(value: string): string {
  return /^[A-Za-z0-9+/=_-]*$/.test(value) ? value : ''
}

/** An origin (scheme://host[:port]) only ever holds these characters. */
function jsStringSafe(value: string): string {
  return /^[A-Za-z0-9.:/[\]-]*$/.test(value) ? value : ''
}

/**
 * `url` with `?token=<file-access JWT>` appended when it is EXACTLY one of
 * this document's image uploads (`/api/files/<docId>/<fileId>`, no query,
 * origin or other path around it — `ownUploadFileId`); otherwise unchanged.
 * Same rule as the server render page (`renderFileTokens.ts`): nothing in
 * the content can make the editor attach the token to a link, an external
 * URL that merely contains the path, or another document's file.
 */
export function withOwnUploadToken(url: string, docId: string, token: string): string {
  if (!token || ownUploadFileId(url, docId) === null) return url
  return `${url}?token=${encodeURIComponent(token)}`
}

/** Add the file token to every `<img src>` in `html` that is one of the document's own uploads. */
export function attachOwnUploadTokens(html: string, docId: string, token: string): string {
  if (!token) return html
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  for (const img of Array.from(template.content.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? ''
    const next = withOwnUploadToken(src, docId, token)
    if (next !== src) {
      img.setAttribute('src', next)
      changed = true
    }
  }
  return changed ? template.innerHTML : html
}

/**
 * Cheap, conservative check whether a render could need the file token:
 * the HTML or the raw custom CSS mention `/api/files/`, or a theme image
 * is an own upload. (Misses nothing; may fetch a token that ends up unused.)
 */
export function mayReferenceOwnUploads(opts: {
  html: string
  theme: Pick<DocTheme, 'brand' | 'header' | 'footer'>
  rawCustomCss: string | undefined
  docId: string
}): boolean {
  const { html, theme, rawCustomCss, docId } = opts
  return html.includes('/api/files/')
    || (rawCustomCss ?? '').includes('/api/files/')
    || [theme.brand.logoUrl, theme.header.imageUrl, theme.footer.imageUrl].some(u => ownUploadFileId(u, docId) !== null)
}

/**
 * Everything the iframe needs to render one document. `customCss` must
 * already carry the token on its own-upload url()s (sanitize it with
 * `fileUrl: path => withOwnUploadToken(path, docId, token)`).
 */
export function buildRenderMessage(opts: {
  html: string
  theme: DocTheme
  title: string
  /** Document language (`ymeta.language`) — date + TOC title + numbers. */
  language: string
  customCss: CustomCssResult | undefined
  docId: string
  fileToken: string
  print: boolean
}): RenderMessage {
  const texts = documentTexts(opts.theme, opts.language)
  const themeCss = themeToCss(opts.theme, {
    title: opts.title,
    date: texts.date,
    tocTitle: texts.tocTitle,
    captionLabels: texts.captionLabels,
    customCss: opts.customCss,
    imageUrl: url => withOwnUploadToken(url, opts.docId, opts.fileToken)
  })
  const hljs = hljsTheme(opts.theme.code.theme)
  return {
    type: 'render',
    html: attachOwnUploadTokens(opts.html, opts.docId, opts.fileToken),
    themeCss,
    fontsImport: themeFontsImport(opts.theme),
    hljsUrl: hljs.url,
    hljsSri: hljs.sri,
    mermaidConfig: JSON.stringify(buildMermaidConfig(opts.theme)),
    locale: texts.locale,
    print: opts.print
  }
}

interface FileTokenResponse { token: string, expiresAt: number }

/** Refresh this long before the token expires. */
const FILE_TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000

/**
 * Cached `file-access` token for one document. `current()` is synchronous
 * (the preview's render path is), `refresh()` fetches a new one.
 * `getDocJwt` supplies the password-unlock / Hocuspocus doc JWT for
 * visitors without a session (sent as Bearer).
 */
export function createFileTokenSource(docId: () => string, getDocJwt?: () => Promise<string | null>) {
  let cached: (FileTokenResponse & { docId: string }) | null = null
  let inflight: Promise<void> | null = null

  function current(): string | null {
    if (!cached || cached.docId !== docId()) return null
    if (cached.expiresAt - Date.now() < FILE_TOKEN_REFRESH_MARGIN_MS) return null
    return cached.token
  }

  function refresh(): Promise<void> {
    if (inflight) return inflight
    const id = docId()
    inflight = (async () => {
      try {
        const jwt = getDocJwt ? await getDocJwt() : null
        const res = await $fetch<FileTokenResponse>(`/api/docs/${encodeURIComponent(id)}/file-token`, {
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined
        })
        cached = { ...res, docId: id }
      } catch (err: unknown) {
        // No access (or offline): render without a token; the images
        // fail exactly as they would for this viewer anyway. Back off a
        // minute so a re-render doesn't hammer the endpoint.
        console.warn('[preview] file-access token unavailable', err)
        cached = { token: '', expiresAt: Date.now() + FILE_TOKEN_REFRESH_MARGIN_MS + 60_000, docId: id }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return { current, refresh }
}

/** Whether the app is currently in dark mode (the `dark` class on <html>). */
export function appIsDark(doc: Document = document): boolean {
  return doc.documentElement.classList.contains('dark')
}
