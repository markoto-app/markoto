import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/pagedjsCdn'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/katexCdn'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/mermaidCdn'
import { hljsTheme } from '~~/shared/utils/hljsCdn'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import type { DocTheme } from '~~/shared/types/theme'
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
 *     the document's own `/api/files/<docId>/…` URLs get a short-lived
 *     `file-access` token appended (`withFileAccessToken`, minted by
 *     `GET /api/docs/:docId/file-token`) — same mechanism as the server
 *     render page;
 *   - the srcdoc inherits the app's CSP, so its inline scripts carry the
 *     page's CSP nonce (`currentCspNonce`).
 */

export type ParentToFrameMessage = RenderMessage | ColorModeMessage

export interface RenderMessage {
  type: 'render'
  html: string
  themeCss: string
  fontsImport: string
  hljsUrl: string
  hljsSri: string
  mermaidTheme: string
  /** Print once paginated (browser print path). */
  print: boolean
}

export interface ColorModeMessage {
  type: 'color-mode'
  dark: boolean
}

export type FrameToParentMessage
  = | { type: 'iframe-ready' }
    | { type: 'paginated', pageCount: number }
    | { type: 'iframe-error', message: string }
    | { type: 'print-shortcut' }
    | { type: 'print-done' }

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
    default:
      return null
  }
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
}

/** Nonces are base64; anything else is dropped rather than escaped. */
function attrSafe(value: string): string {
  return /^[A-Za-z0-9+/=_-]*$/.test(value) ? value : ''
}

/** An origin (scheme://host[:port]) only ever holds these characters. */
function jsStringSafe(value: string): string {
  return /^[A-Za-z0-9.:/[\]-]*$/.test(value) ? value : ''
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function fileUrlPattern(docId: string): RegExp {
  // Own-document image URLs only (the same shape /api/files accepts),
  // not already carrying a query string.
  return new RegExp(String.raw`(/api/files/${escapeRegExp(docId)}/[A-Za-z0-9_-]{1,64}\.(?:png|jpe?g|gif|webp))(?![?\w])`, 'g')
}

/** True when `text` references one of the document's uploaded images. */
export function referencesDocFiles(text: string, docId: string): boolean {
  return fileUrlPattern(docId).test(text)
}

/**
 * Append `?token=<file-access JWT>` to every `/api/files/<docId>/<file>` URL
 * in rendered HTML or CSS. The token is a JWT (base64url + dots), so it is
 * inert inside both an HTML attribute and a CSS `url("…")`.
 */
export function withFileAccessToken(text: string, docId: string, token: string): string {
  if (!token) return text
  return text.replace(fileUrlPattern(docId), `$1?token=${encodeURIComponent(token)}`)
}

/** Everything the iframe needs to render one document, minus the HTML. */
export function buildRenderMessage(opts: {
  html: string
  theme: DocTheme
  title: string
  tocTitle: string
  customCss: CustomCssResult | undefined
  docId: string
  fileToken: string
  print: boolean
}): RenderMessage {
  const dateIso = new Date().toISOString().slice(0, 10)
  const themeCss = themeToCss(opts.theme, {
    title: opts.title,
    date: dateIso,
    tocTitle: opts.tocTitle,
    customCss: opts.customCss
  })
  const hljs = hljsTheme(opts.theme.code.theme)
  return {
    type: 'render',
    html: withFileAccessToken(opts.html, opts.docId, opts.fileToken),
    themeCss: withFileAccessToken(themeCss, opts.docId, opts.fileToken),
    fontsImport: themeFontsImport(opts.theme),
    hljsUrl: hljs.url,
    hljsSri: hljs.sri,
    mermaidTheme: opts.theme.mermaid.theme,
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
