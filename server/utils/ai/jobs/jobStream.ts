import { useLogger } from '../../platform/logger'
import { MINUTE_MS } from '~~/shared/config/units'
import type { JobProgress } from './jobTypes'
import { isJobActive, progressPatch } from './jobView'

const log = useLogger('ai-job-stream')

// Server-Sent Events stream of one delegated job's progress
// (`GET /api/docs/:docId/ai-jobs/:jobId/stream`, initiator only), the same
// shape as the AI session stream (`agentic/sessionStream.ts`): the runner
// publishes every unit over Valkey pub/sub (`subscribeJobProgress`), the
// stream forwards it, re-reads the stored row every few seconds (a lost
// message, a job running on another instance) and keeps the connection
// alive with a comment line (Bun's idle timeout is 10 s).
//
// Events:
//   progress  data = the progress fields of the job view
//   end       data = {}, the job stopped changing (done, cancelled, ...)
// At `maxLifetimeMs` the stream just closes and EventSource reconnects.

export interface JobStreamOptions {
  jobId: string
  /** The stored progress (null: the job is gone). */
  read: () => Promise<JobProgress | null>
  /** Live updates; resolves to the unsubscribe function. */
  subscribe: (listener: (p: JobProgress) => void) => Promise<() => void>
  refreshMs?: number
  maxLifetimeMs?: number
}

const REFRESH_MS = 5_000
const MAX_LIFETIME_MS = 10 * MINUTE_MS
const RETRY_MS = 2_000

export function createJobEventStream(opts: JobStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let closed = false
  let unsubscribe: (() => void) | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let lifetime: ReturnType<typeof setTimeout> | null = null

  function release(): void {
    closed = true
    if (ticker) clearInterval(ticker)
    if (lifetime) clearTimeout(lifetime)
    ticker = null
    lifetime = null
    const unsub = unsubscribe
    unsubscribe = null
    unsub?.()
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSent = ''
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
          // Already closed by the client.
        }
      }
      const emit = (p: JobProgress | null): void => {
        if (closed) return
        if (!p) {
          finish(true)
          return
        }
        const json = JSON.stringify(progressPatch(p))
        if (json !== lastSent) {
          lastSent = json
          send(`event: progress\ndata: ${json}\n\n`)
        }
        if (!isJobActive(p.status)) finish(true)
      }
      const refresh = async (): Promise<void> => {
        try {
          emit(await opts.read())
        } catch {
          // Store blip: try again on the next tick.
        }
      }

      send(`retry: ${RETRY_MS}\n\n`)
      try {
        // Subscribe before the first read so no update slips between them.
        unsubscribe = await opts.subscribe(emit)
      } catch (e) {
        log.warn('job progress subscribe failed, polling', { err: e, jobId: opts.jobId })
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
      }, opts.refreshMs ?? REFRESH_MS)
      lifetime = setTimeout(() => finish(false), opts.maxLifetimeMs ?? MAX_LIFETIME_MS)
    },
    cancel() {
      release()
    }
  })
}
