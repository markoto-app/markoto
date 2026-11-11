import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The sync-server's /internal/** gate (sync-server/src/internal-http.ts):
// edge-forwarded requests and wrong secrets are refused before any Sentry
// span or trace continuation is opened.

const sentry = vi.hoisted(() => ({
  continueTrace: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn())
}))
vi.mock('../../sync-server/src/sentry', () => ({ Sentry: sentry }))
vi.mock('../../sync-server/src/persistence', () => ({ ypgPersistence: { clearDocument: vi.fn(() => Promise.resolve()) } }))
const notBefore = vi.hoisted(() => ({ write: vi.fn(async (_docId: string, _sec: number) => true) }))
vi.mock('../../sync-server/src/doc-not-before', () => ({ writeDocNotBefore: notBefore.write }))

const { handleInternalRequest } = await import('../../sync-server/src/internal-http')

function request(url: string, headers: Record<string, string>, method = 'POST', body?: unknown) {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.method = method
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  const res = new ServerResponse(req)
  let status = 0
  let sent = ''
  const writeHead = res.writeHead.bind(res)
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code
    return writeHead(code, ...(rest as []))
  }) as typeof res.writeHead
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === 'string') sent = chunk
    return res
  }) as typeof res.end
  return { req, res, status: () => status, json: () => JSON.parse(sent) as Record<string, unknown> }
}

const instance = { documents: new Map() }

describe('handleInternalRequest', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_SECRET', 'current-secret')
    vi.stubEnv('INTERNAL_API_SECRET_PREVIOUS', 'previous-secret')
    sentry.continueTrace.mockClear()
    sentry.startSpan.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ignores paths outside /internal/', async () => {
    const r = request('/', {})
    expect(await handleInternalRequest(r.req, r.res, instance as never)).toBe(false)
  })

  it('401s a wrong secret without opening a span or continuing a trace', async () => {
    const r = request('/internal/kick-user', { 'x-internal-secret': 'wrong', 'sentry-trace': 'a-b-1' })
    expect(await handleInternalRequest(r.req, r.res, instance as never)).toBe(true)
    expect(r.status()).toBe(401)
    expect(sentry.continueTrace).not.toHaveBeenCalled()
    expect(sentry.startSpan).not.toHaveBeenCalled()
  })

  it('404s an edge-forwarded request even with the right secret', async () => {
    const r = request('/internal/kick-user', { 'x-internal-secret': 'current-secret', 'x-real-ip': '203.0.113.7' })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.status()).toBe(404)
    expect(sentry.startSpan).not.toHaveBeenCalled()
  })

  it('500s when no secret is configured', async () => {
    vi.stubEnv('INTERNAL_API_SECRET', '')
    const r = request('/internal/kick-user', { 'x-internal-secret': 'previous-secret' })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.status()).toBe(500)
  })

  it('accepts the previous secret during a rotation and then traces the work', async () => {
    const r = request('/internal/does-not-exist', { 'x-internal-secret': 'previous-secret' })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.status()).toBe(404)
    expect(sentry.continueTrace).toHaveBeenCalledOnce()
    expect(sentry.startSpan).toHaveBeenCalledOnce()
  })
})

describe('/internal/reauth-document', () => {
  const SECRET_HEADER = { 'x-internal-secret': 'current-secret' }

  function connection(userId: string | number) {
    return { context: { userId }, close: vi.fn(), webSocket: { close: vi.fn() } }
  }

  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_SECRET', 'current-secret')
    notBefore.write.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('requires the internal secret and stores nothing without it', async () => {
    const r = request('/internal/reauth-document', { 'x-internal-secret': 'wrong' }, 'POST', { docId: 'doc-1', notBefore: 1 })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.status()).toBe(401)
    expect(notBefore.write).not.toHaveBeenCalled()
  })

  it('is refused when it came through the edge proxy', async () => {
    const r = request('/internal/reauth-document', { ...SECRET_HEADER, 'x-real-ip': '203.0.113.7' }, 'POST', { docId: 'doc-1', notBefore: 1 })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.status()).toBe(404)
    expect(notBefore.write).not.toHaveBeenCalled()
  })

  it('400s without a docId or a whole-second cutoff', async () => {
    for (const body of [{ notBefore: 1 }, { docId: 'doc-1' }, { docId: 'doc-1', notBefore: 1.5 }, { docId: '', notBefore: 1 }]) {
      const r = request('/internal/reauth-document', SECRET_HEADER, 'POST', body)
      await handleInternalRequest(r.req, r.res, instance as never)
      expect(r.status()).toBe(400)
    }
    expect(notBefore.write).not.toHaveBeenCalled()
  })

  it('stores the cutoff and closes the document\'s connections, sparing the app\'s own clients', async () => {
    const alice = connection(42)
    const anon = connection('anonymous')
    const ai = connection('ai:assistant:s1')
    const other = connection(7)
    const docs = new Map([
      ['doc-1', { getConnections: () => [alice, anon, ai] }],
      ['doc-2', { getConnections: () => [other] }]
    ])
    const r = request('/internal/reauth-document', SECRET_HEADER, 'POST', { docId: 'doc-1', notBefore: 1_800_000_000 })
    const loaded = { documents: docs }
    await handleInternalRequest(r.req, r.res, loaded as never)
    expect(r.status()).toBe(200)
    expect(r.json()).toEqual({ success: true, closed: 2, cutoffStored: true })
    expect(notBefore.write).toHaveBeenCalledWith('doc-1', 1_800_000_000)
    expect(alice.webSocket.close).toHaveBeenCalledOnce()
    expect(anon.webSocket.close).toHaveBeenCalledOnce()
    expect(ai.close).not.toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
  })

  it('stores the cutoff for a document not loaded here (another instance may hold it)', async () => {
    const r = request('/internal/reauth-document', SECRET_HEADER, 'POST', { docId: 'doc-x', notBefore: 1_800_000_000 })
    await handleInternalRequest(r.req, r.res, instance as never)
    expect(r.json()).toEqual({ success: true, closed: 0, cutoffStored: true })
    expect(notBefore.write).toHaveBeenCalledOnce()
  })
})
