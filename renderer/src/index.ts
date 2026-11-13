// Sentry must be imported first so its Bun instrumentation patches stdlib
// targets (fetch / http / s3) before renderDocument grabs references to
// them. Side-effect import + named import; `Sentry` is the namespace we
// use for continueTrace / startSpan inside the request handler.
import { Sentry } from './sentry'
import { renderDocument } from './render'
import type { RenderRequest } from '../../shared/contracts/render'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '../../shared/utils/security/internalSecret'
import { env } from './env'
import { useLogger } from './logger'

const log = useLogger('renderer')

const PORT = env.renderer.port
const INTERNAL_SECRET = env.auth.internalApiSecret
const INTERNAL_SECRET_PREVIOUS = env.auth.internalApiSecretPrevious ?? null

// Bun.serve over the standalone Playwright/Bun container. Every endpoint
// behind /render gates on the X-Internal-Secret header, the renderer is
// only reachable from the internal network anyway, but defence-in-depth.
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health' && req.method === 'GET') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    if (url.pathname === '/render' && req.method === 'POST') return handleRender(req)
    return new Response('not found', { status: 404 })
  }
})

async function handleRender(req: Request): Promise<Response> {
  const verdict = checkInternalSecret(req.headers.get(INTERNAL_SECRET_HEADER), INTERNAL_SECRET, INTERNAL_SECRET_PREVIOUS)
  if (verdict !== 'ok') return jsonResponse({ error: 'forbidden' }, 403)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  const parsed = parseRenderRequest(isRecord(raw) ? raw : {})
  if (typeof parsed === 'string') return jsonResponse({ error: parsed }, 400)
  return traced(req, parsed)
}

/**
 * Light validation: the calling app already validated upstream, this is a
 * sanity net for stray callers. Returns the request or the error text.
 */
function parseRenderRequest(body: Partial<Record<keyof RenderRequest, unknown>>): RenderRequest | string {
  const { docId, snapshotId, format, variant } = body
  if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) return 'invalid docId'
  if (typeof snapshotId !== 'number' || !Number.isFinite(snapshotId) || snapshotId < 0) return 'invalid snapshotId'
  if (format !== 'pdf' && format !== 'png' && format !== 'both' && format !== 'html') return 'invalid format'
  // Brand-kit fingerprint: part of the output folder, so a
  // workspace font / locked-design change gets its own cache entry.
  if (variant !== undefined && (typeof variant !== 'string' || !/^[a-f0-9]{16}$/.test(variant))) return 'invalid variant'
  return { docId, snapshotId, format, variant }
}

// Distributed-tracing continuation. The app calls this endpoint from
// inside its own transaction (server/utils/rendering/renderClient.ts injects
// sentry-trace + baggage). continueTrace re-creates that propagation
// context here so startSpan opens a CHILD of the upstream root, not
// a sibling. End result: one trace covers browser → app → renderer
// (and the renderer's Playwright `page.goto` to the print page is a
// sibling trace: that hop can't carry headers via Playwright; see
// the operator runbook, kept outside this repository).
function traced(req: Request, request: RenderRequest): Promise<Response> {
  // The app's request id (renderClient.ts sends it with the trace headers),
  // so these lines match the app's log lines of the same request.
  const sentRequestId = req.headers.get('x-request-id')
  const reqLog = sentRequestId && /^[A-Za-z0-9._-]{8,64}$/.test(sentRequestId) ? log.with({ requestId: sentRequestId }) : log
  const sentryTrace = req.headers.get('sentry-trace') ?? undefined
  const baggage = req.headers.get('baggage') ?? undefined
  const { docId, snapshotId, format } = request
  return Sentry.continueTrace({ sentryTrace, baggage }, () => Sentry.startSpan(
    { name: 'POST /render', op: 'http.server', attributes: { docId, snapshotId, format } },
    () => render(request, reqLog)
  ))
}

async function render(request: RenderRequest, reqLog: typeof log): Promise<Response> {
  const { docId, snapshotId, format } = request
  const t0 = Date.now()
  try {
    const out = await renderDocument(request)
    reqLog.info('rendered', { docId, snapshotId, format, pages: out.pageCount, durationMs: Date.now() - t0 })
    return jsonResponse(out, 200)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'render failed'
    const status = (e as { statusCode?: number }).statusCode ?? 500
    reqLog.warn('render failed', { docId, snapshotId, format, durationMs: Date.now() - t0, status, err: e })
    Sentry.captureException(e, {
      tags: { component: 'renderer', event: 'render_failed', docId },
      extra: { snapshotId, format }
    })
    return jsonResponse({ error: msg }, status)
  }
}

log.info('listening', { port: server.port })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// Graceful shutdown: close the browser before exiting so Chromium's temp
// dirs get cleaned up properly. SIGTERM from compose; SIGINT from Ctrl-C.
async function shutdown(signal: string) {
  log.info('shutting down', { signal })
  // Stop accepting requests; the exit below doesn't wait for open ones.
  server.stop().catch((e: unknown) => log.warn('server stop failed', { err: e }))
  // Browser closure happens lazily on next launch; explicit close not
  // required since the kernel reaps the process tree on exit. Skip to
  // avoid blocking shutdown on a stuck browser.
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
