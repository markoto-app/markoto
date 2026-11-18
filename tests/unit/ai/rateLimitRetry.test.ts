import { describe, expect, it, vi } from 'vitest'
import { MAX_RETRY_AFTER_MS, withRateLimitRetry, type RateLimitRetryOptions } from '../../../server/utils/agentic/loop/rateLimitRetry'

function rateLimited(retryAfter?: string): Error {
  return Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} })
}

function scripted(results: Array<Error | string>): () => Promise<string> {
  let i = 0
  return async () => {
    const r = results[i++]
    if (r === undefined) throw new Error('unexpected call')
    if (r instanceof Error) throw r
    return r
  }
}

function opts(extra: Partial<RateLimitRetryOptions> = {}): { waits: number[], o: RateLimitRetryOptions } {
  const waits: number[] = []
  return {
    waits,
    o: {
      signal: new AbortController().signal,
      reserveMs: 30_000,
      log: () => {},
      sleep: async (ms: number) => {
        waits.push(ms)
      },
      ...extra
    }
  }
}

describe('withRateLimitRetry', () => {
  it('backs off 2 s / 5 s / 10 s without Retry-After and succeeds', async () => {
    const { waits, o } = opts()
    await expect(withRateLimitRetry(scripted([rateLimited(), rateLimited(), rateLimited(), 'ok']), o)).resolves.toBe('ok')
    expect(waits).toEqual([2000, 5000, 10000])
  })

  it('gives up after 3 retries with the last 429', async () => {
    const { waits, o } = opts()
    await expect(withRateLimitRetry(scripted([rateLimited(), rateLimited(), rateLimited(), rateLimited()]), o)).rejects.toThrow('429')
    expect(waits).toHaveLength(3)
  })

  it('honours Retry-After, capped', async () => {
    const { waits, o } = opts()
    await withRateLimitRetry(scripted([rateLimited('7'), rateLimited('3600'), 'ok']), o)
    expect(waits).toEqual([7000, MAX_RETRY_AFTER_MS])
  })

  it('does not retry other errors or final ones', async () => {
    const { waits, o } = opts({ isFinal: e => e instanceof Error && e.message.includes('budget') })
    await expect(withRateLimitRetry(scripted([Object.assign(new Error('boom'), { status: 500 })]), o)).rejects.toThrow('boom')
    await expect(withRateLimitRetry(scripted([Object.assign(new Error('budget exceeded'), { status: 429 })]), o)).rejects.toThrow('budget')
    expect(waits).toEqual([])
  })

  it('does not wait past the deadline minus the closing reserve', async () => {
    // 5 s are left before the reserve: the 2 s and 5 s waits fit, the 10 s one does not.
    const { waits, o } = opts({ now: () => 0, deadlineAt: 35_000, reserveMs: 30_000 })
    await expect(withRateLimitRetry(scripted([rateLimited(), rateLimited(), rateLimited(), 'ok']), o)).rejects.toThrow('429')
    expect(waits).toEqual([2000, 5000])
  })

  it('stops once the session is aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const sleep = vi.fn()
    await expect(withRateLimitRetry(scripted([rateLimited()]), { signal: ac.signal, reserveMs: 0, log: () => {}, sleep })).rejects.toThrow('429')
    expect(sleep).not.toHaveBeenCalled()
  })
})
