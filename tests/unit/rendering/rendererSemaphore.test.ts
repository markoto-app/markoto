import { describe, it, expect, vi, afterEach } from 'vitest'
import { PoolWaitTimeoutError, Semaphore } from '../../../renderer/src/semaphore'

// The renderer's page pool. A slot handed from a finishing render to a
// queued one must not be counted down a second time: that lost one slot
// per queued render until every render waited out POOL_WAIT_MS.

const SLOTS = 5

/** A render: hold a slot for `ms`, then give it back (as renderDocument's finally does). */
async function render(pool: Semaphore, ms: number, waitMs = 10_000): Promise<void> {
  await pool.acquire(waitMs)
  try {
    await new Promise(resolve => setTimeout(resolve, ms))
  } finally {
    pool.release()
  }
}

describe('renderer page pool', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gets every slot back after bursts larger than the pool, again and again', async () => {
    const pool = new Semaphore(SLOTS)
    for (let round = 0; round < 6; round++) {
      // 3x the pool: two thirds of the renders queue and are handed a slot.
      await Promise.all(Array.from({ length: SLOTS * 3 }, (_, i) => render(pool, 1 + (i % 4))))
      expect(pool.available).toBe(SLOTS)
      expect(pool.queued).toBe(0)
    }
  })

  it('never runs more renders at once than it has slots', async () => {
    const pool = new Semaphore(SLOTS)
    let running = 0
    let peak = 0
    await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      await pool.acquire(10_000)
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 1 + (i % 3)))
      running--
      pool.release()
    }))
    expect(peak).toBe(SLOTS)
    expect(pool.available).toBe(SLOTS)
  })

  it('serves queued renders in arrival order', async () => {
    const pool = new Semaphore(1)
    await pool.acquire(1000)
    const order: number[] = []
    const queued = [1, 2, 3].map(n => pool.acquire(1000).then(() => {
      order.push(n)
      pool.release()
    }))
    pool.release()
    await Promise.all(queued)
    expect(order).toEqual([1, 2, 3])
    expect(pool.available).toBe(1)
  })

  it('times a waiter out with a 503 error and keeps the slot count intact', async () => {
    vi.useFakeTimers()
    const pool = new Semaphore(1)
    await pool.acquire(1000)
    const waiting = pool.acquire(30_000)
    const failure = waiting.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(30_000)
    const err = await failure
    expect(err).toBeInstanceOf(PoolWaitTimeoutError)
    expect((err as PoolWaitTimeoutError).statusCode).toBe(503)
    expect(pool.queued).toBe(0)
    // The timed-out waiter must not receive the slot released later.
    pool.release()
    expect(pool.available).toBe(1)
    await pool.acquire(1000)
    expect(pool.available).toBe(0)
  })

  it('refuses a release without an acquire instead of growing the pool', () => {
    const pool = new Semaphore(2)
    expect(() => pool.release()).toThrow()
    expect(pool.available).toBe(2)
  })
})
