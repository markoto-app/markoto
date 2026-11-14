// Counting semaphore for the renderer's page pool.
//
// `permits` counts free slots. `acquire()` takes one, or parks the caller
// until `release()` hands one over. A hand-off passes the releasing
// caller's slot straight to the oldest waiter: the slot never becomes
// free in between, so `permits` must not change on that path. (Counting
// it down again on the hand-off lost one slot per queued render until
// the pool was empty for good.)

export class PoolWaitTimeoutError extends Error {
  /** The renderer answers 503: the pool is busy, the caller may retry. */
  readonly statusCode = 503

  constructor() {
    super('Pool wait timeout')
    this.name = 'PoolWaitTimeoutError'
  }
}

export class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(private readonly size: number) {
    this.permits = size
  }

  /** Resolves once the caller holds a slot; rejects after `timeoutMs` in the queue. */
  acquire(timeoutMs: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(grant)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new PoolWaitTimeoutError())
      }, timeoutMs)
      this.waiters.push(grant)
    })
  }

  /** Give the caller's slot to the oldest waiter, or back to the pool. */
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    if (this.permits >= this.size) throw new Error('Semaphore released more often than acquired')
    this.permits++
  }

  /** Free slots right now (tests and diagnostics). */
  get available(): number {
    return this.permits
  }

  /** Callers waiting for a slot right now. */
  get queued(): number {
    return this.waiters.length
  }
}
