import WebSocket from 'ws'
import { TEST_BASE_URL } from './env'

// Thin WebSocket test client over the `ws` npm package (already a
// transitive dep via Nitro). Gives our integration tests a queue-
// based `nextMessage` / `nextMessageOfType` API instead of forcing
// every assertion into a bespoke `ws.on('message', …)` promise.
//
// Alternatives considered:
//   - `mock-socket`: mocks WS on the client side for real-server
//     absent tests. We have a real server; not the fit.
//   - `websocket-as-promised`: forces request/response semantics;
//     our protocol is push-based (server emits partials spontaneously).
//   - VueUse's `useWebSocket`: designed for component state; overkill
//     in a Node test.
// 50 lines of queue handling is cleaner than any of them.

export type WsJson = Record<string, unknown>

export interface WsClient {
  send(data: string | Buffer): void
  sendJson(obj: WsJson): void
  /**
   * Wait for the next text message that satisfies `predicate`. If no
   * predicate is given, returns the first text message. Times out
   * with a descriptive error so tests don't hang indefinitely.
   */
  nextMessage(predicate?: (msg: WsJson) => boolean, timeoutMs?: number): Promise<WsJson>
  /**
   * Convenience: wait for a message whose `type` matches. Frequent
   * enough in dictation tests to warrant its own helper.
   */
  nextMessageOfType(type: string, timeoutMs?: number): Promise<WsJson>
  /** Wait for the socket to close; returns the close event. */
  closed(timeoutMs?: number): Promise<{ code: number, reason: string }>
  /** Close the socket from the test side. */
  close(): void
  /** Underlying ws instance — escape hatch for rare edge cases. */
  raw: WebSocket
}

/**
 * Open a WebSocket against the test server at `pathAndQuery` (e.g.
 * `/api/ai/dictate`). Returns a client with queue-based message
 * reading. Tracks itself in a global registry so tests can't leak
 * dangling sockets; close all via `closeAllWs()` in `afterEach`.
 */
export async function openWs(pathAndQuery: string): Promise<WsClient> {
  const url = TEST_BASE_URL.replace(/^http/, 'ws') + pathAndQuery
  const ws = new WebSocket(url)

  const jsonQueue: WsJson[] = []
  const waiters: Array<(m: WsJson) => boolean> = []
  // Each waiter owns a `resolve`; we scan on new message or new waiter.
  const waiterResolvers = new Map<(m: WsJson) => boolean, (m: WsJson) => void>()

  let closeEvent: { code: number, reason: string } | null = null
  const closeWaiters: Array<(e: { code: number, reason: string }) => void> = []

  ws.on('message', (raw) => {
    // crossws + ws delivers text as Buffer; try JSON-parse. Tests
    // that need to assert on binary echoes can use `raw` directly.
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    let parsed: WsJson
    try { parsed = JSON.parse(text) } catch { return }
    // Match first matching waiter if any; otherwise queue.
    for (const predicate of waiters) {
      if (predicate(parsed)) {
        const resolve = waiterResolvers.get(predicate)!
        waiterResolvers.delete(predicate)
        waiters.splice(waiters.indexOf(predicate), 1)
        resolve(parsed)
        return
      }
    }
    jsonQueue.push(parsed)
  })

  ws.on('close', (code, reason) => {
    closeEvent = { code, reason: reason.toString() }
    for (const w of closeWaiters) w(closeEvent)
  })

  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => reject(err)
    ws.once('open', () => { ws.off('error', fail); resolve() })
    ws.once('error', fail)
  })

  const client: WsClient = {
    raw: ws,
    send(data) { ws.send(data) },
    sendJson(obj) { ws.send(JSON.stringify(obj)) },
    nextMessage(predicate = () => true, timeoutMs = 3000) {
      const matchIdx = jsonQueue.findIndex(m => predicate(m))
      if (matchIdx >= 0) return Promise.resolve(jsonQueue.splice(matchIdx, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiterResolvers.delete(predicate)
          const idx = waiters.indexOf(predicate)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`Timeout waiting for WS message after ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push(predicate)
        waiterResolvers.set(predicate, (m) => { clearTimeout(timer); resolve(m) })
      })
    },
    nextMessageOfType(type, timeoutMs = 3000) {
      return this.nextMessage(m => m.type === type, timeoutMs)
    },
    closed(timeoutMs = 3000) {
      if (closeEvent) return Promise.resolve(closeEvent)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for WS close after ${timeoutMs}ms`)), timeoutMs)
        closeWaiters.push((e) => { clearTimeout(timer); resolve(e) })
      })
    },
    close() { ws.close() }
  }

  openSockets.push(client)
  return client
}

const openSockets: WsClient[] = []

/** Close every socket opened via `openWs`. Call in `afterEach`. */
export function closeAllWs() {
  while (openSockets.length) {
    const c = openSockets.shift()!
    try { c.raw.close() } catch { /* best-effort */ }
  }
}
