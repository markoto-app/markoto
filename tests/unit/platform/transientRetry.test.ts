import { describe, it, expect, vi, afterEach } from 'vitest'
import { isTransientError, withTransientRetry } from '../../../app/utils/api/retry'

// Reads that can fail while a sidecar starts (the AI Points budget lives in
// LiteLLM) are asked again with backoff; a 4xx is an answer and is not.

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { statusCode: status })

afterEach(() => {
  vi.useRealTimers()
})

describe('isTransientError', () => {
  it('network errors and 5xx are transient, 4xx and aborts are not', () => {
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientError(httpError(500))).toBe(true)
    expect(isTransientError(httpError(503))).toBe(true)
    expect(isTransientError(httpError(401))).toBe(false)
    expect(isTransientError(httpError(404))).toBe(false)
    expect(isTransientError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false)
  })
})

describe('withTransientRetry', () => {
  it('retries a 5xx with the given delays until it succeeds', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValue('ok')
    const result = withTransientRetry(fn, { delays: [100, 200] })
    await vi.advanceTimersByTimeAsync(99)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    await expect(result).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('gives up after the last delay and rethrows', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(httpError(503))
    const caught = withTransientRetry(fn, { delays: [10] }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(await caught).toMatchObject({ statusCode: 503 })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(403))
    await expect(withTransientRetry(fn, { delays: [10] })).rejects.toMatchObject({ statusCode: 403 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when the request is aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fn = vi.fn().mockRejectedValue(httpError(500))
    const caught = withTransientRetry(fn, { delays: [1000], signal: controller.signal }).then(() => 'resolved', () => 'rejected')
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    expect(await caught).toBe('rejected')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
