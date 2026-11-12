// Browser side of the self-hosted ALTCHA bot check: solve a challenge
// from GET /api/anon-gate/challenge in a small pool of web workers and
// encode the payload the server verifies (server/utils/anonGate/altcha.ts).
//
// Each worker tests an interleaved slice of counters (start i, step n);
// the first one to find the key wins and the rest are stopped. Pure
// apart from the injected `createWorker`, so it is unit-testable.

export interface AltchaChallenge {
  parameters: Record<string, unknown>
  signature?: string
}

export interface AltchaSolution {
  counter: number
  derivedKey: string
  time?: number
}

export interface WorkerLike {
  postMessage: (message: unknown) => void
  terminate: () => void
  addEventListener: (type: 'message' | 'error', listener: (event: { data?: unknown }) => void) => void
}

export interface SolveOptions {
  createWorker: () => WorkerLike
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
}

function isSolution(value: unknown): value is AltchaSolution {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.counter === 'number' && typeof v.derivedKey === 'string'
}

/** How many workers: half the cores (min 1, max 4), fast without pegging a phone. */
export function solverConcurrency(hardwareConcurrency: number | undefined): number {
  const cores = typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0 ? hardwareConcurrency : 2
  return Math.min(4, Math.max(1, Math.floor(cores / 2)))
}

export function solveAltchaChallenge(challenge: AltchaChallenge, options: SolveOptions): Promise<AltchaSolution | null> {
  const concurrency = Math.max(1, options.concurrency ?? 2)
  const timeout = options.timeoutMs ?? 90_000
  const workers: WorkerLike[] = []
  return new Promise<AltchaSolution | null>((resolve) => {
    let pending = concurrency
    let settled = false
    const finish = (result: AltchaSolution | null) => {
      if (settled) return
      settled = true
      for (const w of workers) {
        w.postMessage({ type: 'abort' })
        w.terminate()
      }
      resolve(result)
    }
    options.signal?.addEventListener('abort', () => finish(null))
    for (let i = 0; i < concurrency; i++) {
      const worker = options.createWorker()
      workers.push(worker)
      worker.addEventListener('message', (event) => {
        if (isSolution(event.data)) {
          finish(event.data)
          return
        }
        // null (timeout / not found) or an error object from this worker.
        pending--
        if (pending === 0) finish(null)
      })
      worker.addEventListener('error', () => {
        pending--
        if (pending === 0) finish(null)
      })
      worker.postMessage({ type: 'work', challenge, counterStart: i, counterStep: concurrency, timeout })
    }
  })
}

/** The payload the server expects: base64 of `{"challenge", "solution"}`. */
export function encodeAltchaPayload(challenge: AltchaChallenge, solution: AltchaSolution): string {
  const json = JSON.stringify({ challenge, solution: { counter: solution.counter, derivedKey: solution.derivedKey } })
  // The JSON is ASCII (hex strings, numbers, our own keys).
  return btoa(json)
}
