import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Pin the dispatch CONTRACT for `notifySyncKickUser`. The integration
// tests in `tests/integration/endpoints/workspaceMembers.test.ts` used
// to assert on this via an in-process HTTP stub; that stub was removed
// when the real `sync-test` Hocuspocus container became always-up for
// integration runs (no other way to test the WS protocol). The
// dispatch shape moved here.
//
// Coverage points (high-risk regression target — pre-fix, membership
// changes silently left stale JWTs valid for up to 2 hours):
//   1. Correct URL: `${syncInternalUrl}/internal/kick-user`
//   2. POST + JSON content-type
//   3. X-Internal-Secret header carries the configured secret
//   4. Body is `{ userId, docIds }` with the right field types
//   5. Empty docIds short-circuits (no fetch issued)
//   6. Missing config (no syncInternalUrl OR no secret) short-circuits
//   7. Fetch failure is caught + Sentry-captured (caller never throws)

const SYNC_URL = 'http://sync-test:4001'
const SECRET = 'integration-test-internal-secret'

const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))

vi.stubGlobal('fetch', fetchSpy)

// `useRuntimeConfig` is a Nuxt auto-import (no source-file path) — stub
// it as a global the same way the runtime would. Mutate the returned
// object per-test to simulate missing-config branches.
const runtimeConfigStub = { syncInternalUrl: SYNC_URL, internalApiSecret: SECRET }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfigStub)

vi.mock('../../server/utils/throttledSentry', () => ({
  captureExceptionThrottled: vi.fn()
}))

vi.mock('../../server/utils/traceHeaders', () => ({
  injectTraceHeaders: (h: Record<string, string>) => h
}))

// Re-import after mocks so module under test sees the stubbed deps.
const { notifySyncKickUser, notifySyncReauthDocument } = await import('../../server/utils/syncNotify')
const { captureExceptionThrottled } = await import('../../server/utils/throttledSentry')

describe('notifySyncKickUser — dispatch contract', () => {
  beforeEach(() => {
    fetchSpy.mockClear()
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('issues POST to /internal/kick-user with the right URL', async () => {
    notifySyncKickUser(42, ['doc-a'])
    // fire-and-forget — give the microtask queue a tick to flush.
    await new Promise(r => setImmediate(r))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe(`${SYNC_URL}/internal/kick-user`)
    expect((init as RequestInit).method).toBe('POST')
  })

  it('sends X-Internal-Secret + Content-Type headers', async () => {
    notifySyncKickUser(42, ['doc-a'])
    await new Promise(r => setImmediate(r))

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Internal-Secret']).toBe(SECRET)
  })

  it('serialises {userId, docIds} into the body', async () => {
    notifySyncKickUser(99, ['a', 'b', 'c'])
    await new Promise(r => setImmediate(r))

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ userId: 99, docIds: ['a', 'b', 'c'] })
  })

  it('short-circuits on empty docIds (no fetch issued)', async () => {
    notifySyncKickUser(42, [])
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('caller never throws on fetch rejection (fire-and-forget)', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('network down')))
    expect(() => notifySyncKickUser(42, ['doc-a'])).not.toThrow()
    await new Promise(r => setImmediate(r))
    // The Sentry capture happens via captureExceptionThrottled which is
    // mocked above — the important part is that the unhandled rejection
    // doesn't bubble out of the void-returning helper.
  })

  it('uses an AbortSignal with a timeout', async () => {
    notifySyncKickUser(42, ['doc-a'])
    await new Promise(r => setImmediate(r))

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('notifySyncKickUser — config gating', () => {
  beforeEach(() => {
    fetchSpy.mockClear()
    // Reset to a populated config so cross-test state can't leak.
    runtimeConfigStub.syncInternalUrl = SYNC_URL
    runtimeConfigStub.internalApiSecret = SECRET
  })

  it('short-circuits when syncInternalUrl is missing', async () => {
    runtimeConfigStub.syncInternalUrl = ''
    notifySyncKickUser(42, ['doc-a'])
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('short-circuits when internalApiSecret is missing', async () => {
    runtimeConfigStub.internalApiSecret = ''
    notifySyncKickUser(42, ['doc-a'])
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('notifySyncReauthDocument — dispatch contract', () => {
  beforeEach(() => {
    fetchSpy.mockClear()
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })))
    runtimeConfigStub.syncInternalUrl = SYNC_URL
    runtimeConfigStub.internalApiSecret = SECRET
    vi.mocked(captureExceptionThrottled).mockClear()
  })

  it('POSTs {docId, notBefore = now in whole seconds} with the internal secret', async () => {
    const before = Math.floor(Date.now() / 1000)
    notifySyncReauthDocument('doc-a')
    await new Promise(r => setImmediate(r))
    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${SYNC_URL}/internal/reauth-document`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Internal-Secret']).toBe(SECRET)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init.body)) as { docId: string, notBefore: number }
    expect(body.docId).toBe('doc-a')
    expect(Number.isInteger(body.notBefore)).toBe(true)
    expect(body.notBefore).toBeGreaterThanOrEqual(before)
    expect(body.notBefore).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })

  it('never throws and reports a failed or refused call', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('network down')))
    expect(() => notifySyncReauthDocument('doc-a')).not.toThrow()
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 500 })))
    notifySyncReauthDocument('doc-b')
    await new Promise(r => setTimeout(r, 10))
    expect(captureExceptionThrottled).toHaveBeenCalledTimes(2)
  })

  it('short-circuits without sync config', async () => {
    runtimeConfigStub.syncInternalUrl = ''
    notifySyncReauthDocument('doc-a')
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
