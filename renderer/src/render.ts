import jwt from 'jsonwebtoken'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { RENDER_JWT_FIXED_CLAIMS, RENDER_TOKEN_TTL_SECONDS } from '../../shared/contracts/jwt'
import type { RenderManifest, RenderRequest, RenderResponse, WebSnapshot } from '../../shared/contracts/render'
import { putBytes } from './s3'
import { buildAllowedOrigins, hostForLog, isAllowedUrl } from './allowlist'
import { env } from './env'
import { useLogger } from './logger'

const log = useLogger('render')

// One persistent browser, page-pool of POOL_SIZE. New BrowserContext per
// render isolates cookies / storage between docs. The pool is a simple
// semaphore: counter goes down when a context is acquired, back up on
// release. POOL_WAIT_MS bounds how long we'll queue before 503-ing.
//
// Sizing: ~80MB/context × 5 = 400MB peak + ~250MB Chromium baseline =
// ~650MB worst case, well under the renderer service's mem_limit: 2g
// (set in deploy/compose/compose.prod.yml). A 3-slot pool queues most of 50
// concurrent PDF requests past POOL_WAIT_MS (30 s); 5 slots raise throughput
// without approaching the memory cap.
const POOL_SIZE = 5
const POOL_WAIT_MS = 30_000
const RENDER_TIMEOUT_MS = 60_000
const NAV_TIMEOUT_MS = 30_000
const PAGED_READY_TIMEOUT_MS = 45_000
const MAX_PAGES = 50

const APP_URL = env.renderer.appUrl
const INTERNAL_SECRET = env.auth.internalApiSecret

// Origins Chromium may talk to (SSRF lockdown, see ./allowlist.ts).
const ALLOWED_ORIGINS = buildAllowedOrigins({
  APP_URL: env.renderer.appUrl,
  S3_ENDPOINT: env.storage.endpoint,
  S3_PUBLIC_ENDPOINT: env.storage.publicEndpoint,
  RENDERER_ALLOWED_ORIGINS: env.renderer.allowedOrigins.join(',')
})
log.info('network allowlist', { origins: [...ALLOWED_ORIGINS] })
// At most this many distinct blocked hosts are logged per render.
const MAX_BLOCKED_LOGS_PER_RENDER = 10

// Chromium's own sandbox stays ON. The container runs as an unprivileged
// user with no capabilities; the namespace sandbox then needs unprivileged
// user namespaces, which the compose files allow with deploy/config/renderer/seccomp.json
// (docs/SECURITY-HARDENING.md §C.2). RENDERER_CHROMIUM_SANDBOX=false is
// an operator escape hatch for hosts that forbid user namespaces outright,
// it is logged loudly because it removes a whole layer.
const CHROMIUM_SANDBOX = env.renderer.chromiumSandbox
if (!CHROMIUM_SANDBOX) {
  log.warn('RENDERER_CHROMIUM_SANDBOX=false: Chromium runs WITHOUT its sandbox')
}

// Where Chromium sends `localhost` lookups (see getBrowser). The docker
// host by default; the dev and test stacks point it at their SeaweedFS
// container instead, because they publish ports on 127.0.0.1 only, which
// the docker host's bridge address doesn't serve.
// A bare hostname (validated by the env loader): it is spliced into a
// Chromium command-line flag.
const LOCALHOST_TARGET = env.renderer.localhostTarget

let browserPromise: Promise<Browser> | null = null
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // `--host-resolver-rules`: rewrite `localhost` lookups inside the
    // renderer's Chromium to RENDERER_LOCALHOST_TARGET. In dev, presigned S3
    // URLs carry the app's S3 host (`localhost:8333`), but inside the
    // renderer container `localhost` is the container itself, so images
    // would silently 404 and be missing from the PDF. In prod the presigned
    // host is the external S3 endpoint, so the rule never fires.
    // EXCLUDE_LOCALHOST leaves names that already resolve locally (the
    // renderer's own /health probe at 127.0.0.1:9000) untouched.
    //
    // `--font-render-hinting=none`: headless Chromium on Linux hints glyphs
    // and lays text out with whole-pixel, hinted advances, the PDF then
    // carries those positions. Fonts without TrueType hints (the bundled
    // TeX Gyre faces) go through the auto-hinter and come out with gaps
    // ("T his", "Dat e" in TeX Gyre Heros: T 10 px instead of 8.15 px at
    // 10 pt). Unhinted layout uses the fonts' real advances, as a desktop
    // browser's preview does.
    const browserArgs = [
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
      `--host-resolver-rules=MAP localhost ${LOCALHOST_TARGET}`
    ]
    browserPromise = chromium.launch({ args: browserArgs, chromiumSandbox: CHROMIUM_SANDBOX })
  }
  return browserPromise
}

// Simple counting semaphore: `permits` tracks free slots; `waiters` are
// resolvers parked on `acquire()` waiting for one. `release()` either hands
// a slot to the oldest waiter or bumps the counter.
class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []
  constructor(initial: number) {
    this.permits = initial
  }

  async acquire(timeoutMs: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.waiters.indexOf(grant)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('Pool wait timeout'))
      }, timeoutMs)
      const grant = () => {
        clearTimeout(t)
        this.permits--
        resolve()
      }
      this.waiters.push(grant)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.permits++
  }
}
const pool = new Semaphore(POOL_SIZE)

/** A published page's snapshot can't exceed this (the app checks again). */
const MAX_WEB_SNAPSHOT_CHARS = 8 * 1024 * 1024

/**
 * Mint the render-JWT the app's middleware accepts on /_internal/render/*.
 * Signed with INTERNAL_API_SECRET, scope='render', 60 s TTL. The app's
 * verifyRenderToken double-checks docId matches the route param.
 *
 * The payload shape is `RenderJwtPayload` in `shared/contracts/jwt.ts`; the
 * app's `verifyRenderToken` rejects any drift with a 403.
 */
function mintRenderToken(docId: string, snapshotId: number): string {
  return jwt.sign(
    { ...RENDER_JWT_FIXED_CLAIMS, docId, snapshotId },
    INTERNAL_SECRET,
    { expiresIn: RENDER_TOKEN_TTL_SECONDS }
  )
}

export async function renderDocument(input: RenderRequest): Promise<RenderResponse> {
  await pool.acquire(POOL_WAIT_MS)
  const created: { context: BrowserContext | null } = { context: null }
  try {
    const browser = await getBrowser()
    return await Promise.race([
      doRender(input, browser, (ctx) => { created.context = ctx }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Render hard timeout')), RENDER_TIMEOUT_MS)
      )
    ])
  } finally {
    // Best-effort context teardown. Errors swallowed, if it's already
    // closed (timeout path), close() throws and we don't care.
    try {
      await created.context?.close()
    } catch { /* noop */ }
    pool.release()
  }
}

/**
 * Abort every request outside the allowlist and refuse WebSockets outright.
 *
 * KNOWN GAP (verified empirically): Playwright does NOT re-enter this handler
 * for HTTP redirect hops of a request it `continue()`d, so an allowed origin
 * that 302s to a blocked one is not caught here. The print page's own CSP
 * (server/utils/rendering/csp.ts, enforced by Chromium on every hop) closes that
 * gap: keep both layers.
 *
 * Logs the blocked HOST only (never path/query, they can carry tokens),
 * once per host per render, capped.
 */
async function lockDownNetwork(context: BrowserContext, docId: string): Promise<void> {
  const loggedHosts = new Set<string>()
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (isAllowedUrl(url, ALLOWED_ORIGINS)) {
      await route.continue()
      return
    }
    const host = hostForLog(url)
    if (!loggedHosts.has(host) && loggedHosts.size < MAX_BLOCKED_LOGS_PER_RENDER) {
      loggedHosts.add(host)
      log.warn('blocked request to a host outside the allowlist', { host, docId })
    }
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket(/.*/, ws => ws.close())
}

/**
 * The web snapshot of a published page: the print page in `mode=web` renders the
 * markdown with the document's theme but without paged.js, and leaves the
 * result on `window.__webSnapshot`. Nothing is uploaded, the app stores it.
 */
async function readWebSnapshot(page: Page): Promise<WebSnapshot> {
  await page.waitForFunction(
    () => (globalThis as { __webReady?: boolean }).__webReady === true,
    null,
    { timeout: PAGED_READY_TIMEOUT_MS }
  )
  const raw = await page.evaluate(() => (globalThis as { __webSnapshot?: unknown }).__webSnapshot)
  const snap: Partial<Record<keyof WebSnapshot, unknown>> | undefined = typeof raw === 'object' && raw !== null ? { ...raw } : undefined
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const web: WebSnapshot = {
    html: str(snap?.html),
    css: str(snap?.css),
    fontsImport: str(snap?.fontsImport),
    hljsTheme: str(snap?.hljsTheme),
    hljsUrl: typeof snap?.hljsUrl === 'string' ? snap.hljsUrl : null,
    language: str(snap?.language)
  }
  if (web.html.length + web.css.length + web.fontsImport.length > MAX_WEB_SNAPSHOT_CHARS) {
    throw Object.assign(new Error('Document too large to publish'), { statusCode: 413 })
  }
  return web
}

async function doRender(
  input: RenderRequest,
  browser: Browser,
  setContext: (ctx: BrowserContext) => void
): Promise<RenderResponse> {
  const { docId, snapshotId, format } = input

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
    // 1.5x devicePixelRatio gives us ~144 DPI screenshots out of A4-sized
    // pages. Higher DPRs trade file size for negligible vision-model gain.
    deviceScaleFactor: 1.5,
    // No service workers: they could fetch outside context.route().
    serviceWorkers: 'block'
  })
  setContext(context)
  await lockDownNetwork(context, docId)
  const page = await context.newPage()
  page.setDefaultTimeout(NAV_TIMEOUT_MS)

  const token = mintRenderToken(docId, snapshotId)
  const url = `${APP_URL}/_internal/render/${encodeURIComponent(docId)}?t=${encodeURIComponent(token)}${format === 'html' ? '&mode=web' : ''}`

  await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })

  if (format === 'html') return { pageCount: 0, pageKeys: [], web: await readWebSnapshot(page) }

  // The print page (app/pages/_internal/render/[docId].vue) renders paged.js
  // at the TOP level (not inside an iframe, different from the editor's
  // preview pane) precisely so page.pdf() and per-page screenshots can
  // target the paginated DOM directly. The page sets these globals after
  // paged.js fires its `after` hook.
  await page.waitForFunction(
    () => (globalThis as { __pagedReady?: boolean }).__pagedReady === true,
    null,
    { timeout: PAGED_READY_TIMEOUT_MS }
  )

  const pageCount = await page.evaluate(() =>
    (globalThis as { __pagedPageCount?: number }).__pagedPageCount ?? 0
  )
  if (pageCount === 0) throw new Error('Paginated to zero pages, empty doc?')
  if (pageCount > MAX_PAGES) {
    throw Object.assign(
      new Error(`Doc has ${pageCount} pages; max allowed is ${MAX_PAGES}`),
      { statusCode: 413 }
    )
  }

  const prefix = `renders/${docId}/${snapshotId}${input.variant ? `-${input.variant}` : ''}`
  const uploads: Promise<unknown>[] = []
  let pdfKey: string | undefined
  const pageKeys: string[] = []

  if (format === 'pdf' || format === 'both') {
    // Force a full image-decode + paint pass before page.pdf(). Reading
    // naturalWidth/naturalHeight on every paginated <img> AND returning the
    // data to Node is what reliably commits images to the print pipeline;
    // calling .decode() inside the page alone leaves page.pdf() dropping
    // images.
    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('.pagedjs_page img'))
      await Promise.all(imgs.map(i => (i as HTMLImageElement).decode().catch(() => undefined)))
    })
    // Sync barrier: round-trip image dimensions back to Node. The
    // serialize-back-to-Node hop is load-bearing, it forces Chromium
    // to await the in-page evaluate to fully complete, which appears
    // to be when image data finally lands in the print compositor.
    // Don't simplify this: silently breaks PDF image rendering.
    await page.evaluate(() => Array.from(document.querySelectorAll('.pagedjs_page img'))
      .map(i => ({ w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight }))
    )
    // emulateMedia({ media: 'print' }) makes @page rules apply.
    // preferCSSPageSize lets the theme's @page declaration drive paper
    // size: without it page.pdf() silently falls back to Letter.
    await page.emulateMedia({ media: 'print' })
    const pdfBytes = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true
    })
    pdfKey = `${prefix}/document.pdf`
    uploads.push(putBytes(pdfKey, pdfBytes, 'application/pdf'))
    // Restore screen media so subsequent screenshots reflect the same
    // pagination the iframe shows in dev (paged.js's CSS doesn't need
    // print media to be active, the @page rules are already applied
    // to the .pagedjs_page elements during pagination).
    await page.emulateMedia({ media: 'screen' })
  }

  if (format === 'png' || format === 'both') {
    const pageEls = page.locator('.pagedjs_page')
    const actual = await pageEls.count()
    for (let i = 0; i < actual; i++) {
      const buf = await pageEls.nth(i).screenshot({ type: 'png' })
      const key = `${prefix}/page-${i + 1}.png`
      pageKeys.push(key)
      uploads.push(putBytes(key, buf, 'image/png'))
    }
  }

  await Promise.all(uploads)

  // Manifest written LAST. Readers HEAD it as the "render complete" sentinel
  // before fetching page bytes, partial renders show as no manifest.
  const manifest: RenderManifest = {
    snapshotId,
    pageCount,
    format,
    renderedAt: new Date().toISOString(),
    pdfKey: pdfKey ?? null,
    pageKeys
  }
  await putBytes(
    `${prefix}/manifest.json`,
    Buffer.from(JSON.stringify(manifest)),
    'application/json'
  )

  return { pageCount, pdfKey, pageKeys }
}
