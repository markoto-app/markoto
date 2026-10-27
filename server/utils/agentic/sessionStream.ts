import { readSessionChannel, toSessionView, valkeyChannelStore, type ChannelStore } from './sessionChannel'

// Server-Sent Events stream of one AI session's initiator-only channel
// (`GET /api/ai/sessions/:sessionId/stream`). Replaces the prompt bar's
// 600 ms polling of `GET /api/ai/sessions/:id` with one long-lived
// response per session.
//
// How it stays current: every channel write PUBLISHes a ping (Valkey
// pub/sub, all instances); the stream re-reads the keys on each ping and
// sends a `status` event only when the view changed. A periodic re-read
// (`refreshMs`) covers a ping lost to a subscriber reconnect, and its
// comment line (`: ping`) keeps the connection from idling out — Bun's
// default idle timeout is 10 s, Traefik's far longer, so `refreshMs`
// stays well below 10 s.
//
// Events:
//   status  data = the same JSON as `GET /api/ai/sessions/:id`
//   end     data = {} — the session is finished (terminal phase seen and
//           `terminalGraceMs` passed) or its channel expired; the client
//           closes its EventSource instead of reconnecting.
// A stream that reaches `maxLifetimeMs` just closes (no `end`), so the
// browser's EventSource reconnects and the client keeps following.
//
// Cleanup: the response body's `cancel` (client went away — Bun cancels
// the body; Nitro's node-compat request never emits `close` for the bun
// preset) and every close path release the subscription and timers.

export interface SessionStreamOptions {
  sessionId: string
  /** Initiator — the stream ends if the channel ever names someone else. */
  userId: number
  store?: ChannelStore
  /** Periodic re-read + keep-alive interval. */
  refreshMs?: number
  /** Re-read interval used when the pub/sub subscription failed. */
  fallbackRefreshMs?: number
  /** How long to keep streaming after a terminal phase (a late answer still arrives). */
  terminalGraceMs?: number
  maxLifetimeMs?: number
}

export const STREAM_REFRESH_MS = 5_000
export const STREAM_FALLBACK_REFRESH_MS = 1_000
export const STREAM_TERMINAL_GRACE_MS = 3_000
export const STREAM_MAX_LIFETIME_MS = 10 * 60_000
/** Browser reconnect delay after a dropped stream (SSE `retry:` field). */
export const STREAM_RETRY_MS = 2_000

const TERMINAL_PHASES = new Set(['done', 'error'])

export function createSessionEventStream(opts: SessionStreamOptions): ReadableStream<Uint8Array> {
  const store = opts.store ?? valkeyChannelStore
  const refreshMs = opts.refreshMs ?? STREAM_REFRESH_MS
  const fallbackRefreshMs = opts.fallbackRefreshMs ?? STREAM_FALLBACK_REFRESH_MS
  const terminalGraceMs = opts.terminalGraceMs ?? STREAM_TERMINAL_GRACE_MS
  const maxLifetimeMs = opts.maxLifetimeMs ?? STREAM_MAX_LIFETIME_MS
  const encoder = new TextEncoder()

  let closed = false
  let unsubscribe: (() => void) | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  function release(): void {
    closed = true
    if (ticker) clearInterval(ticker)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    if (graceTimer) clearTimeout(graceTimer)
    ticker = null
    lifetimeTimer = null
    graceTimer = null
    const unsub = unsubscribe
    unsubscribe = null
    unsub?.()
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          release()
        }
      }
      const finish = (withEnd: boolean): void => {
        if (closed) return
        if (withEnd) send('event: end\ndata: {}\n\n')
        release()
        try {
          controller.close()
        } catch {
          // Already closed / cancelled by the client.
        }
      }

      let lastSent = ''
      let refreshing = false
      let again = false
      const refresh = async (): Promise<void> => {
        if (closed) return
        if (refreshing) {
          again = true
          return
        }
        refreshing = true
        try {
          do {
            again = false
            let snapshot
            try {
              snapshot = await readSessionChannel(opts.sessionId, store)
            } catch {
              // Valkey blip: keep the stream, try again on the next ping / tick.
              return
            }
            if (closed) return
            if (snapshot?.initiatorUserId !== opts.userId) {
              finish(true)
              return
            }
            const view = toSessionView(snapshot)
            const json = JSON.stringify(view)
            if (json !== lastSent) {
              lastSent = json
              send(`event: status\ndata: ${json}\n\n`)
            }
            if (TERMINAL_PHASES.has(view.phase) && graceTimer === null) {
              graceTimer = setTimeout(() => {
                void refresh().finally(() => finish(true))
              }, terminalGraceMs)
            }
          } while (again && !closed)
        } finally {
          refreshing = false
        }
      }

      send(`retry: ${STREAM_RETRY_MS}\n\n`)
      let interval = refreshMs
      try {
        // Subscribe BEFORE the first read so no change can slip between them.
        unsubscribe = await store.subscribe(opts.sessionId, () => {
          void refresh()
        })
      } catch (e) {
        console.warn(`[ai/session-stream] subscribe failed, re-reading every ${fallbackRefreshMs} ms: ${e instanceof Error ? e.message : String(e)}`)
        interval = fallbackRefreshMs
      }
      if (closed) {
        release()
        return
      }
      await refresh()
      if (closed) return
      ticker = setInterval(() => {
        send(': ping\n\n')
        void refresh()
      }, interval)
      lifetimeTimer = setTimeout(() => finish(false), maxLifetimeMs)
    },
    cancel() {
      release()
    }
  })
}
