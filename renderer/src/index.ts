// Sentry must be imported first so its Bun instrumentation patches stdlib
// targets (fetch / http / s3) before renderDocument grabs references to
// them. Side-effect import + named import; `Sentry` is the namespace we
// use for continueTrace / startSpan inside the request handler.
import { Sentry } from './sentry'
import { renderDocument, type RenderInput } from './render'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from './internalSecret'

const PORT = Number.parseInt(process.env.PORT || '9000', 10)
const INTERNAL_SECRET = (() => {
  const v = process.env.INTERNAL_API_SECRET
  if (!v) throw new Error('[renderer] INTERNAL_API_SECRET environment variable is required')
  return v
})()
const INTERNAL_SECRET_PREVIOUS = process.env.INTERNAL_API_SECRET_PREVIOUS || null

// Bun.serve over the standalone Playwright/Bun container. Every endpoint
// behind /render gates on the X-Internal-Secret header — the renderer is
// only reachable from the internal network anyway, but defence-in-depth.
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/health' && req.method === 'GET') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    if (url.pathname === '/render' && req.method === 'POST') {
      const verdict = checkInternalSecret(req.headers.get(INTERNAL_SECRET_HEADER), INTERNAL_SECRET, INTERNAL_SECRET_PREVIOUS)
      if (verdict !== 'ok') {
        return jsonResponse({ error: 'forbidden' }, 403)
      }

      let body: Partial<RenderInput>
      try {
        body = await req.json() as Partial<RenderInput>
      } catch {
        return jsonResponse({ error: 'invalid JSON body' }, 400)
      }

      // Light validation — the calling app already validated upstream, this
      // is a sanity net for stray callers.
      const { docId, snapshotId, format, variant } = body
      if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
        return jsonResponse({ error: 'invalid docId' }, 400)
      }
      if (typeof snapshotId !== 'number' || !Number.isFinite(snapshotId) || snapshotId < 0) {
        return jsonResponse({ error: 'invalid snapshotId' }, 400)
      }
      if (format !== 'pdf' && format !== 'png' && format !== 'both' && format !== 'html') {
        return jsonResponse({ error: 'invalid format' }, 400)
      }
      // Brand-kit fingerprint (WP10): part of the output folder, so a
      // workspace font / locked-design change gets its own cache entry.
      if (variant !== undefined && (typeof variant !== 'string' || !/^[a-f0-9]{16}$/.test(variant))) {
        return jsonResponse({ error: 'invalid variant' }, 400)
      }

      // Distributed-tracing continuation. The app calls this endpoint from
      // inside its own transaction (server/utils/renderClient.ts injects
      // sentry-trace + baggage). continueTrace re-creates that propagation
      // context here so startSpan opens a CHILD of the upstream root, not
      // a sibling. End result: one trace covers browser → app → renderer
      // (and the renderer's Playwright `page.goto` to the print page is a
      // sibling trace — that hop can't carry headers via Playwright; see
      // OBSERVABILITY.md §4 for the limitation).
      const sentryTrace = req.headers.get('sentry-trace') ?? undefined
      const baggage = req.headers.get('baggage') ?? undefined
      return await Sentry.continueTrace({ sentryTrace, baggage }, () => {
        return Sentry.startSpan(
          { name: 'POST /render', op: 'http.server', attributes: { docId, snapshotId, format } },
          async () => {
            const t0 = Date.now()
            try {
              const out = await renderDocument({ docId, snapshotId, format, variant })
              console.log(`[renderer] docId=${docId} snap=${snapshotId} format=${format} `
                + `pages=${out.pageCount} ms=${Date.now() - t0}`)
              return jsonResponse(out, 200)
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'render failed'
              const status = (e as { statusCode?: number }).statusCode ?? 500
              console.warn(`[renderer] docId=${docId} snap=${snapshotId} ms=${Date.now() - t0} failed:`, msg)
              Sentry.captureException(e, {
                tags: { component: 'renderer', event: 'render_failed', docId },
                extra: { snapshotId, format }
              })
              return jsonResponse({ error: msg }, status)
            }
          }
        )
      })
    }

    return new Response('not found', { status: 404 })
  }
})

console.log(`[renderer] listening on :${server.port}`)

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// Graceful shutdown — close the browser before exiting so Chromium's temp
// dirs get cleaned up properly. SIGTERM from compose; SIGINT from Ctrl-C.
async function shutdown(signal: string) {
  console.log(`[renderer] received ${signal}, shutting down`)
  server.stop()
  // Browser closure happens lazily on next launch; explicit close not
  // required since the kernel reaps the process tree on exit. Skip to
  // avoid blocking shutdown on a stuck browser.
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
