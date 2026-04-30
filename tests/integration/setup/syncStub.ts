import { createServer, type Server } from 'node:http'
import { TEST_SYNC_PORT } from './env'

// In-process HTTP stub that impersonates the Hocuspocus sync-server's
// internal endpoints. Pointed at via `NUXT_SYNC_INTERNAL_URL`. Every call
// is recorded in memory so tests can assert the Nuxt app *attempted* to
// kick a user / notify a delete after a membership mutation.
//
// We don't verify the X-Internal-Secret here — `notifySyncKickUser` sends
// it, but the point of the stub is to verify Nuxt's outbound behaviour,
// not to replay the secret check (that's covered by syncSecrets.test.ts).

export interface RecordedCall {
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
}

let server: Server | null = null
let calls: RecordedCall[] = []

export async function startSyncStub(): Promise<void> {
  if (server) return

  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v
      }
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      calls.push({
        path: req.url || '',
        method: req.method || '',
        headers,
        body
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, stub: true }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(TEST_SYNC_PORT, '127.0.0.1', () => resolve())
  })
}

export async function stopSyncStub(): Promise<void> {
  if (!server) return
  // `close()` only stops accepting new connections — it waits for ALL
  // open ones to finish. The Nuxt fire-and-forget kicks (e.g.
  // `notifySyncKickUser`) keep keep-alive sockets to the stub even
  // after the response, and Node won't drop them by itself. Without
  // `closeAllConnections` (Node 18.2+) this hangs the afterAll
  // hook for the full 120s test-stack timeout. Belt and braces:
  // call closeAllConnections then close().
  server.closeAllConnections()
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
}

export function getSyncCalls(): RecordedCall[] {
  return [...calls]
}

export function clearSyncCalls(): void {
  calls = []
}

/**
 * Wait until at least one call matches the predicate, or timeout. The
 * kick notify is fire-and-forget on the Nuxt side — the mutation HTTP
 * response returns before the POST lands here, so tests that assert on
 * kicks need to poll briefly rather than checking synchronously.
 */
export async function waitForSyncCall(
  predicate: (c: RecordedCall) => boolean,
  timeoutMs = 2000
): Promise<RecordedCall> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = calls.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`[sync-stub] no matching call after ${timeoutMs}ms. Recorded: ${JSON.stringify(calls, null, 2)}`)
}
