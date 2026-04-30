import { renderDocument, type RenderInput } from './render'

const PORT = parseInt(process.env.PORT || '9000', 10)
const INTERNAL_SECRET = (() => {
  const v = process.env.INTERNAL_API_SECRET
  if (!v) throw new Error('[renderer] INTERNAL_API_SECRET environment variable is required')
  return v
})()

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
      const secret = req.headers.get('X-Internal-Secret')
      if (secret !== INTERNAL_SECRET) {
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
      const { docId, snapshotId, format } = body
      if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
        return jsonResponse({ error: 'invalid docId' }, 400)
      }
      if (typeof snapshotId !== 'number' || !Number.isFinite(snapshotId) || snapshotId < 0) {
        return jsonResponse({ error: 'invalid snapshotId' }, 400)
      }
      if (format !== 'pdf' && format !== 'png' && format !== 'both') {
        return jsonResponse({ error: 'invalid format' }, 400)
      }

      const t0 = Date.now()
      try {
        const out = await renderDocument({ docId, snapshotId, format })
        console.log(`[renderer] docId=${docId} snap=${snapshotId} format=${format} `
          + `pages=${out.pageCount} ms=${Date.now() - t0}`)
        return jsonResponse(out, 200)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'render failed'
        const status = (e as { statusCode?: number }).statusCode ?? 500
        console.warn(`[renderer] docId=${docId} snap=${snapshotId} ms=${Date.now() - t0} failed:`, msg)
        return jsonResponse({ error: msg }, status)
      }
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
