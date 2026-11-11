// Server entry for the production build (`nitro.entry` in nuxt.config.ts).
// A copy of nitropack's `bun` preset entry (nitropack 2.13,
// dist/presets/bun/runtime/bun.mjs) with ONE addition: a request-body
// size limit enforced by Bun itself.
//
// Why: the preset entry calls `await req.arrayBuffer()` on every request
// before any route handler runs, so no handler can refuse an oversized
// body before it is fully in memory (Bun's own default cap is 128 MB).
// With `maxRequestBodySize`, Bun answers 413 as soon as a declared
// `Content-Length` is over the limit, and stops a chunked body the moment
// it passes the limit. The largest legitimate body is a document import
// (`/api/import`: 50 MB file + multipart framing = 51 MiB); browser
// uploads go to S3 with presigned URLs and never through the app.
//
// Left out on purpose: the preset's `startScheduleRunner()` (no Nitro
// scheduled tasks are configured) and its `import.meta._websocket`
// switches (websockets are always on).
//
// Upgrade guard: the preset source this copy was derived from is pinned
// in tests/fixtures/nitropack/bun-preset-entry.mjs.txt, and
// tests/unit/platform/bunEntryUpstream.test.ts fails as soon as the installed
// nitropack ships a different preset entry. Carry the change over here,
// then refresh the snapshot.

import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
import wsAdapter from 'crossws/adapters/bun'

/** Default request-body cap (51 MiB). Override: NITRO_MAX_REQUEST_BODY_BYTES. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 51 * 1024 * 1024

/** The slice of Bun's runtime API this entry uses (no bun-types in the app tsconfig). */
interface BunServeOptions {
  port: string | number
  hostname?: string
  idleTimeout?: number
  maxRequestBodySize: number
  websocket: unknown
  fetch: (req: Request, server: unknown) => Response | Promise<Response> | undefined | Promise<Response | undefined>
}
declare const Bun: { serve: (options: BunServeOptions) => { url: URL } }

function parseIntOrUndefined(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '')
  return Number.isNaN(parsed) ? undefined : parsed
}

const nitroApp = useNitroApp()
// nitro.experimental.websocket is on (live dictation), so the adapter is always needed.
const ws = wsAdapter(nitroApp.h3App.websocket)

const server = Bun.serve({
  port: process.env.NITRO_PORT || process.env.PORT || 3e3,
  hostname: process.env.NITRO_HOST || process.env.HOST,
  idleTimeout: parseIntOrUndefined(process.env.NITRO_BUN_IDLE_TIMEOUT),
  maxRequestBodySize: parseIntOrUndefined(process.env.NITRO_MAX_REQUEST_BODY_BYTES) ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
  websocket: ws.websocket,
  async fetch(req, server2) {
    if (req.headers.get('upgrade') === 'websocket') {
      return ws.handleUpgrade(req, server2)
    }
    const url = new URL(req.url)
    let body: ArrayBuffer | undefined
    if (req.body) {
      body = await req.arrayBuffer()
    }
    return nitroApp.localFetch(url.pathname + url.search, {
      host: url.hostname,
      protocol: url.protocol,
      headers: req.headers,
      method: req.method,
      redirect: req.redirect,
      body
    })
  }
})
console.log(`Listening on ${server.url}...`)
