import { describe, it, expect, vi, beforeEach } from 'vitest'

// `injectTraceHeaders` is a thin wrapper around Sentry's `getTraceData()`
// that we call from every cross-service `fetch(...)` site to propagate
// the active trace into the downstream container. We test three things:
//
//   1. With no active span (getTraceData returns {}), headers pass through
//      unchanged. This is the common case when Sentry isn't initialised
//      (DSN unset in dev) — the tracing path mustn't break unauthenticated
//      requests.
//   2. With an active span, the returned headers include the upstream-
//      provided keys plus `sentry-trace` + `baggage`. Order matters: the
//      injected keys must NOT overwrite caller-provided headers like
//      `X-Internal-Secret`, but the caller's headers must NOT clobber
//      tracing keys either (we own them).
//   3. If `getTraceData` throws (an SDK bug shouldn't take down the
//      originating mutation), the wrapper falls back to the caller's
//      headers unchanged — graceful degradation.

const getTraceDataMock = vi.fn()
vi.mock('@sentry/nuxt', () => ({
  // The wrapper reads `Sentry.getTraceData?.()` so we expose it as a
  // function. Tests configure the mock per-case below.
  getTraceData: () => getTraceDataMock()
}))

describe('injectTraceHeaders', () => {
  beforeEach(() => {
    getTraceDataMock.mockReset()
  })

  it('passes the caller headers through when no span is active', async () => {
    getTraceDataMock.mockReturnValue({})
    const { injectTraceHeaders } = await import('../../../server/utils/platform/traceHeaders')
    const out = injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': 'secret123'
    })
    expect(out).toEqual({
      'Content-Type': 'application/json',
      'X-Internal-Secret': 'secret123'
    })
  })

  it('merges sentry-trace + baggage onto the caller headers when a span is active', async () => {
    getTraceDataMock.mockReturnValue({
      'sentry-trace': '1234abcd5678efgh-0000abcd1234efgh-1',
      'baggage': 'sentry-environment=development,sentry-public_key=abc'
    })
    const { injectTraceHeaders } = await import('../../../server/utils/platform/traceHeaders')
    const out = injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': 'secret123'
    })
    expect(out['Content-Type']).toBe('application/json')
    expect(out['X-Internal-Secret']).toBe('secret123')
    expect(out['sentry-trace']).toBe('1234abcd5678efgh-0000abcd1234efgh-1')
    expect(out.baggage).toBe('sentry-environment=development,sentry-public_key=abc')
  })

  it('returns the caller headers unchanged if the Sentry SDK throws', async () => {
    getTraceDataMock.mockImplementation(() => {
      throw new Error('Sentry SDK exploded')
    })
    const { injectTraceHeaders } = await import('../../../server/utils/platform/traceHeaders')
    const out = injectTraceHeaders({
      'X-Internal-Secret': 'secret123'
    })
    // Graceful fallback: the originating mutation must not fail because
    // tracing did. If we threw here, every render / kick / activity-log
    // call would bubble a 500 the moment Sentry hiccuped.
    expect(out).toEqual({ 'X-Internal-Secret': 'secret123' })
  })
})
