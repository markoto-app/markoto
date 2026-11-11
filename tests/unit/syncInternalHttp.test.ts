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

const { handleInternalRequest } = await import('../../sync-server/src/internal-http')

function request(url: string, headers: Record<string, string>, method = 'POST') {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.method = method
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  // An empty body for handlers that read one.
  req.push(null)
  const res = new ServerResponse(req)
  let status = 0
  const writeHead = res.writeHead.bind(res)
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code
    return writeHead(code, ...(rest as []))
  }) as typeof res.writeHead
  res.end = (() => res) as typeof res.end
  return { req, res, status: () => status }
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
