import { describe, it, expect, beforeEach, vi } from 'vitest'

// Tests the per-component probe functions + the parallel aggregator.
// The Nitro endpoint itself (`server/api/health.get.ts`) lives behind
// the subprocess-only coverage gap (AGENTS.md §11), so unit-level
// confidence focuses on the helpers it composes.

// ─── Mocks ────────────────────────────────────────────────────────────────
// `vi.hoisted` keeps these references stable across the hoisted vi.mock
// factory and the test bodies — the factory is moved to top of file by
// vitest, so a closure over a top-level `let` would be undefined at mock
// resolution time.

const mockState = vi.hoisted(() => ({
  dbExecute: async (): Promise<unknown> => ({ rows: [{ '?column?': 1 }] }),
  valkeyPing: async (): Promise<unknown> => 'PONG'
}))

vi.mock('../../server/utils/database', () => ({
  useDatabase: () => ({
    execute: () => mockState.dbExecute()
  })
}))

vi.mock('../../server/utils/valkey', () => ({
  useValkey: () => ({
    ping: () => mockState.valkeyPing()
  })
}))

// Dynamic import after mocks register — same shape as other unit tests
// (see `idempotency.test.ts`).
const {
  probePostgres,
  probeValkey,
  probeSync,
  probeRenderer,
  probeMarkitdown,
  runAllProbes,
  isOverallHealthy,
  getCachedHealth,
  _resetHealthCache
} = await import('../../server/utils/healthProbes')

// fetch helper that resolves after `delay` ms with the given status.
function fakeFetch(status: number, delay = 0): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        resolve(new Response('ok', { status }))
      }, delay)
      // Honour AbortSignal so timeout-bound probes can detect cancellation.
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        const err = new Error('aborted')
        err.name = 'TimeoutError'
        reject(err)
      })
    })
  }) as typeof fetch
}

beforeEach(() => {
  mockState.dbExecute = async () => ({ rows: [{ '?column?': 1 }] })
  mockState.valkeyPing = async () => 'PONG'
  _resetHealthCache()
  vi.restoreAllMocks()
})

// ─── Probe-level ──────────────────────────────────────────────────────────

describe('probePostgres', () => {
  it('returns ok on a successful SELECT 1', async () => {
    const r = await probePostgres()
    expect(r.status).toBe('ok')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns down when the query throws', async () => {
    mockState.dbExecute = async () => {
      throw new Error('connection refused')
    }
    const r = await probePostgres()
    expect(r.status).toBe('down')
    expect(r.error).toContain('connection refused')
  })
})

describe('probeValkey', () => {
  it('returns ok on PONG', async () => {
    const r = await probeValkey()
    expect(r.status).toBe('ok')
  })

  it('returns down when ping rejects', async () => {
    mockState.valkeyPing = async () => {
      throw new Error('NOAUTH')
    }
    const r = await probeValkey()
    expect(r.status).toBe('down')
    expect(r.error).toContain('NOAUTH')
  })
})

describe('HTTP probes', () => {
  it('skip when URL is empty / undefined / null', async () => {
    expect((await probeSync('')).status).toBe('skipped')
    expect((await probeRenderer(undefined)).status).toBe('skipped')
    expect((await probeMarkitdown(null)).status).toBe('skipped')
  })

  it('returns ok on 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await probeSync('http://sync:4001')
    expect(r.status).toBe('ok')
  })

  it('returns down on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(500))
    const r = await probeRenderer('http://renderer:9000')
    expect(r.status).toBe('down')
    expect(r.error).toContain('500')
  })

  it('returns down on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await probeMarkitdown('http://markitdown:8080')
    expect(r.status).toBe('down')
    expect(r.error).toContain('ECONNREFUSED')
  })

  it('strips trailing slashes from configured URLs before joining /health', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    await probeSync('http://sync:4001/')
    expect(spy).toHaveBeenCalledWith('http://sync:4001/health', expect.any(Object))
  })
})

// ─── Aggregator ───────────────────────────────────────────────────────────

describe('runAllProbes + isOverallHealthy', () => {
  it('all green → healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080'
    })
    expect(isOverallHealthy(r)).toBe(true)
    expect(r.postgres.status).toBe('ok')
    expect(r.valkey.status).toBe('ok')
    expect(r.sync.status).toBe('ok')
    expect(r.renderer.status).toBe('ok')
    expect(r.markitdown.status).toBe('ok')
  })

  it('postgres down → degraded', async () => {
    mockState.dbExecute = async () => {
      throw new Error('boom')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080'
    })
    expect(isOverallHealthy(r)).toBe(false)
    expect(r.postgres.status).toBe('down')
  })

  it('valkey down → degraded (independent of HTTP probes)', async () => {
    mockState.valkeyPing = async () => {
      throw new Error('connection lost')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080'
    })
    expect(isOverallHealthy(r)).toBe(false)
    expect(r.valkey.status).toBe('down')
    expect(r.sync.status).toBe('ok')
  })

  it('sync 500 → degraded', async () => {
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(((_u: string) => {
      callCount++
      // First HTTP probe (sync) returns 500, others 200.
      const status = callCount === 1 ? 500 : 200
      return Promise.resolve(new Response('', { status }))
    }) as typeof fetch)
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080'
    })
    expect(isOverallHealthy(r)).toBe(false)
    expect(r.sync.status).toBe('down')
  })

  it('unconfigured renderer URL is skipped (not down)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: '', // unconfigured
      markitdownUrl: 'http://markitdown:8080'
    })
    expect(r.renderer.status).toBe('skipped')
    // Skipped probes don't flag overall-down — the instance still serves
    // its primary path. Documented in healthProbes.ts.
    expect(isOverallHealthy(r)).toBe(true)
  })

  it('two calls within healthy TTL → one probe round', async () => {
    _resetHealthCache()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const dbSpy = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }))
    mockState.dbExecute = dbSpy
    const valkeySpy = vi.fn(async () => 'PONG')
    mockState.valkeyPing = valkeySpy

    const r1 = await getCachedHealth({
      syncUrl: 'http://sync',
      rendererUrl: 'http://renderer',
      markitdownUrl: 'http://md'
    })
    const r2 = await getCachedHealth({
      syncUrl: 'http://sync',
      rendererUrl: 'http://renderer',
      markitdownUrl: 'http://md'
    })

    expect(r1).toBe(r2) // same cached object
    expect(r1.status).toBe(200)
    expect(dbSpy).toHaveBeenCalledTimes(1)
    expect(valkeySpy).toHaveBeenCalledTimes(1)
    // 3 HTTP probes per probe round, only one round.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('degraded result is cached + reports per-component checks', async () => {
    _resetHealthCache()
    mockState.valkeyPing = async () => {
      throw new Error('NOAUTH')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const cached = await getCachedHealth({
      syncUrl: 'http://sync',
      rendererUrl: 'http://renderer',
      markitdownUrl: 'http://md'
    })
    expect(cached.status).toBe(503)
    expect(cached.body.status).toBe('degraded')
    if (cached.body.status !== 'degraded') return
    expect(cached.body.checks.valkey).toBe('down')
    expect(cached.body.checks.postgres).toBe('ok')
  })

  it('runs probes in parallel — total wall-clock is < sum of latencies', async () => {
    // Each HTTP probe sleeps 100 ms; postgres + valkey are instant.
    // If serial: ≥300 ms. If parallel: ≈100 ms.
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200, 100))
    const t0 = performance.now()
    await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080'
    })
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(250)
  })
})
