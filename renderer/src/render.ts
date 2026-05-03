import jwt from 'jsonwebtoken'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { putBytes } from './s3'

// One persistent browser, page-pool of POOL_SIZE. New BrowserContext per
// render isolates cookies / storage between docs. The pool is a simple
// semaphore — counter goes down when a context is acquired, back up on
// release. POOL_WAIT_MS bounds how long we'll queue before 503-ing.
//
// Sizing: ~80MB/context × 5 = 400MB peak + ~250MB Chromium baseline =
// ~650MB worst case, well under the renderer service's mem_limit: 2g
// (set in docker-compose.prod.yml). 5 was chosen over 3 because at 50
// concurrent PDF requests, a 3-slot pool puts 47 requests in the queue —
// many time-out at POOL_WAIT_MS (30s). 5 raises throughput linearly
// without approaching the memory cap.
const POOL_SIZE = 5
const POOL_WAIT_MS = 30_000
const RENDER_TIMEOUT_MS = 60_000
const NAV_TIMEOUT_MS = 30_000
const PAGED_READY_TIMEOUT_MS = 45_000
const MAX_PAGES = 50
// Render token TTL — short enough that a leaked token is useless quickly,
// long enough that slow Hocuspocus sync (cold doc, big history) doesn't
// 401 mid-render. 60 s matches the app-side mint.
const TOKEN_TTL_SECONDS = 60

const APP_URL = process.env.APP_URL || 'http://app:3000'
const INTERNAL_SECRET = (() => {
  const v = process.env.INTERNAL_API_SECRET
  if (!v) throw new Error('[renderer] INTERNAL_API_SECRET environment variable is required')
  return v
})()

let browserPromise: Promise<Browser> | null = null
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // `--host-resolver-rules`: rewrite `localhost` DNS lookups inside the
    // renderer's Chromium to `host.docker.internal`. This solves the
    // dev networking gotcha: presigned S3 URLs are minted with the
    // app's S3 endpoint host (e.g. `localhost:8333` in dev where
    // SeaweedFS is published on the host), but from inside the
    // renderer container `localhost` IS the container — nothing's
    // listening on :8333. The redirect target then 404s silently and
    // images don't appear in the PDF.
    //
    // Mapping `localhost` → `host.docker.internal` routes those lookups
    // through the docker bridge gateway to the host's loopback, which
    // has the published S3 port. In prod, presigned URLs use the
    // external S3 endpoint (Infomaniak), so this rule is harmless —
    // it only fires on `localhost` lookups, which prod never produces.
    //
    // EXCLUDE_LOCALHOST keeps anything that ALREADY resolves locally
    // (the renderer's own /health probe at 127.0.0.1:9000) untouched.
    const browserArgs = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--host-resolver-rules=MAP localhost host.docker.internal'
    ]
    browserPromise = chromium.launch({ args: browserArgs })
  }
  return browserPromise
}

// Simple counting semaphore: `permits` tracks free slots; `waiters` are
// resolvers parked on `acquire()` waiting for one. `release()` either hands
// a slot to the oldest waiter or bumps the counter.
class Semaphore {
  private permits: number
  private waiters: Array<() => void> = []
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

export interface RenderInput {
  docId: string
  snapshotId: number
  format: 'pdf' | 'png' | 'both'
}

export interface RenderOutput {
  pageCount: number
  pdfKey?: string
  pageKeys: string[]
}

/**
 * Mint the render-JWT the app's middleware accepts on /_internal/render/*.
 * Signed with INTERNAL_API_SECRET, scope='render', 60 s TTL. The app's
 * verifyRenderToken double-checks docId matches the route param.
 *
 * CONTRACT: this payload shape MUST match `RenderJwtPayload` +
 * `RENDER_JWT_FIXED_CLAIMS` in `shared/contracts/jwt.ts`. The renderer
 * runs in its own Docker build context (./renderer) so we can't import
 * the shared module here — the contract is enforced by the app-side
 * `verifyRenderToken` rejecting any drift with a 403, and by the
 * integration tests in `tests/integration/endpoints/printPage.test.ts`.
 * If you change this shape, update the shared contract AND the verifier.
 */
function mintRenderToken(docId: string, snapshotId: number): string {
  return jwt.sign(
    { docId, snapshotId, scope: 'render' },
    INTERNAL_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  )
}

export async function renderDocument(input: RenderInput): Promise<RenderOutput> {
  await pool.acquire(POOL_WAIT_MS)
  let context: BrowserContext | null = null
  try {
    const browser = await getBrowser()
    return await Promise.race([
      doRender(input, browser, (ctx) => { context = ctx }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Render hard timeout')), RENDER_TIMEOUT_MS)
      )
    ])
  } finally {
    // Best-effort context teardown. Errors swallowed — if it's already
    // closed (timeout path), close() throws and we don't care.
    try {
      await context?.close()
    } catch { /* noop */ }
    pool.release()
  }
}

async function doRender(
  input: RenderInput,
  browser: Browser,
  setContext: (ctx: BrowserContext) => void
): Promise<RenderOutput> {
  const { docId, snapshotId, format } = input

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
    // 1.5x devicePixelRatio gives us ~144 DPI screenshots out of A4-sized
    // pages. Higher DPRs trade file size for negligible vision-model gain.
    deviceScaleFactor: 1.5
  })
  setContext(context)
  const page = await context.newPage()
  page.setDefaultTimeout(NAV_TIMEOUT_MS)

  const token = mintRenderToken(docId, snapshotId)
  const url = `${APP_URL}/_internal/render/${encodeURIComponent(docId)}?t=${encodeURIComponent(token)}`

  await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })

  // The print page (app/pages/_internal/render/[docId].vue) renders paged.js
  // at the TOP level (not inside an iframe — different from the editor's
  // preview pane) precisely so page.pdf() and per-page screenshots can
  // target the paginated DOM directly. The page sets these globals after
  // paged.js fires its `after` hook.
  await page.waitForFunction(
    () => (window as { __pagedReady?: boolean }).__pagedReady === true,
    null,
    { timeout: PAGED_READY_TIMEOUT_MS }
  )

  const pageCount = await page.evaluate(() =>
    (window as { __pagedPageCount?: number }).__pagedPageCount ?? 0
  )
  if (pageCount === 0) throw new Error('Paginated to zero pages — empty doc?')
  if (pageCount > MAX_PAGES) {
    throw Object.assign(
      new Error(`Doc has ${pageCount} pages; max allowed is ${MAX_PAGES}`),
      { statusCode: 413 }
    )
  }

  const prefix = `renders/${docId}/${snapshotId}`
  const uploads: Promise<unknown>[] = []
  let pdfKey: string | undefined
  const pageKeys: string[] = []

  if (format === 'pdf' || format === 'both') {
    // Force a full image-decode + paint pass before page.pdf().
    // Empirically: an in-page evaluate that ACCESSES naturalWidth/
    // naturalHeight on every paginated <img> AND returns the data
    // back to Node is what reliably commits images to the print
    // pipeline. Just calling .decode() inside the page (without the
    // sync boundary back to Node) wasn't enough — page.pdf() still
    // dropped images. Mirroring the exact pattern from the standalone
    // probe that produced correct PDFs.
    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('.pagedjs_page img'))
      await Promise.all(imgs.map(i => (i as HTMLImageElement).decode().catch(() => undefined)))
    })
    // Sync barrier: round-trip image dimensions back to Node. The
    // serialize-back-to-Node hop is load-bearing — it forces Chromium
    // to await the in-page evaluate to fully complete, which appears
    // to be when image data finally lands in the print compositor.
    // Don't simplify this — silently breaks PDF image rendering.
    await page.evaluate(() => Array.from(document.querySelectorAll('.pagedjs_page img'))
      .map(i => ({ w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight }))
    )
    // emulateMedia({ media: 'print' }) makes @page rules apply.
    // preferCSSPageSize lets the theme's @page declaration drive paper
    // size — without it page.pdf() silently falls back to Letter.
    await page.emulateMedia({ media: 'print' })
    const pdfBytes = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true
    })
    pdfKey = `${prefix}/document.pdf`
    uploads.push(putBytes(pdfKey, pdfBytes, 'application/pdf'))
    // Restore screen media so subsequent screenshots reflect the same
    // pagination the iframe shows in dev (paged.js's CSS doesn't need
    // print media to be active — the @page rules are already applied
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
  // before fetching page bytes — partial renders show as no manifest.
  const manifest = {
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
