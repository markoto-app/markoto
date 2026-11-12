import { describe, it, expect, beforeEach, vi } from 'vitest'

// Tests the per-component probe functions + the parallel aggregator.
// The Nitro endpoint itself (`server/api/health.get.ts`) lives behind
// the subprocess-only coverage gap (docs/contributing/testing.md, "Coverage"), so unit-level
// confidence focuses on the helpers it composes.

// Mocks
// `vi.hoisted` keeps these references stable across the hoisted vi.mock
// factory and the test bodies — the factory is moved to top of file by
// vitest, so a closure over a top-level `let` would be undefined at mock
// resolution time.

const mockState = vi.hoisted(() => ({
  dbExecute: async (): Promise<unknown> => ({ rows: [{ '?column?': 1 }] }),
  valkeyPing: async (): Promise<unknown> => 'PONG',
  s3Send: async (): Promise<unknown> => ({})
}))

vi.mock('../../../server/utils/platform/database', () => ({
  useDatabase: () => ({
    execute: () => mockState.dbExecute()
  })
}))

vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: () => ({
    ping: () => mockState.valkeyPing()
  })
}))

vi.mock('../../../server/utils/storage/s3', () => ({
  useS3Client: () => ({
    send: () => mockState.s3Send()
  })
}))

// Dynamic import after mocks register — same shape as other unit tests
// (see `idempotency.test.ts`).
const {
  probePostgres,
  probeValkey,
  probeSync,
  probeS3,
  probeRenderer,
  probeMarkitdown,
  probeLitellm,
  runAllProbes,
  isOverallHealthy,
  getCachedHealth,
  getCachedProbeResults,
  _resetHealthCache
} = await import('../../../server/utils/platform/healthProbes')

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
  mockState.s3Send = async () => ({})
  _resetHealthCache()
  vi.restoreAllMocks()
})

// Probe-level

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

  it('never reports credentials a driver error quotes', async () => {
    mockState.dbExecute = async () => {
      throw new Error('getaddrinfo ENOTFOUND for postgres://markoto_app:hunter2-db-pass@db:5432/markoto?sslpassword=pw2')
    }
    const r = await probePostgres()
    expect(r.status).toBe('down')
    expect(r.error).toContain('ENOTFOUND')
    expect(r.error).not.toContain('hunter2')
    expect(r.error).not.toContain('pw2')
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

describe('probeS3', () => {
  it('skips when no bucket is configured', async () => {
    expect((await probeS3('')).status).toBe('skipped')
    expect((await probeS3(undefined)).status).toBe('skipped')
    expect((await probeS3(null)).status).toBe('skipped')
  })

  it('returns ok when HeadBucket succeeds', async () => {
    const r = await probeS3('markoto-bucket')
    expect(r.status).toBe('ok')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns down when HeadBucket rejects (bucket unreachable / bad creds)', async () => {
    mockState.s3Send = async () => {
      throw new Error('NoSuchBucket')
    }
    const r = await probeS3('markoto-bucket')
    expect(r.status).toBe('down')
    expect(r.error).toContain('NoSuchBucket')
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

// Aggregator

describe('runAllProbes + isOverallHealthy', () => {
  it('all green → healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    expect(isOverallHealthy(r)).toBe(true)
    expect(r.postgres.status).toBe('ok')
    expect(r.valkey.status).toBe('ok')
    expect(r.sync.status).toBe('ok')
    expect(r.renderer.status).toBe('ok')
    expect(r.markitdown.status).toBe('ok')
    expect(r.litellm.status).toBe('ok')
  })

  it('postgres down → degraded', async () => {
    mockState.dbExecute = async () => {
      throw new Error('boom')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
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
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    expect(isOverallHealthy(r)).toBe(false)
    expect(r.valkey.status).toBe('down')
    expect(r.sync.status).toBe('ok')
  })

  it('sync 500 → degraded', async () => {
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      callCount++
      // sync URL returns 500, others 200. Match by URL since probe order
      // is non-deterministic across Promise.allSettled.
      const status = url.includes('sync:4001') ? 500 : 200
      return Promise.resolve(new Response('', { status }))
    }) as typeof fetch)
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    expect(callCount).toBeGreaterThan(0)
    expect(isOverallHealthy(r)).toBe(false)
    expect(r.sync.status).toBe('down')
  })

  it('unconfigured renderer URL is skipped (not down)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: '', // unconfigured
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    expect(r.renderer.status).toBe('skipped')
    // Skipped probes don't flag overall-down — the instance still serves
    // its primary path. Documented in healthProbes.ts.
    expect(isOverallHealthy(r)).toBe(true)
  })

  it('LiteLLM probe hits /health/liveliness specifically (not /health)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    await probeLitellm('http://litellm:4000')
    expect(spy).toHaveBeenCalledWith('http://litellm:4000/health/liveliness', expect.any(Object))
  })

  it('unconfigured LiteLLM URL is skipped (not down)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: ''
    })
    expect(r.litellm.status).toBe('skipped')
    expect(isOverallHealthy(r)).toBe(true)
  })

  it('LiteLLM down → degraded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const status = url.includes('litellm') ? 503 : 200
      return Promise.resolve(new Response('', { status }))
    }) as typeof fetch)
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    expect(r.litellm.status).toBe('down')
    expect(isOverallHealthy(r)).toBe(false)
  })

  it('reports S3 when a bucket is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000',
      s3Bucket: 'markoto-bucket'
    })
    expect(r.s3.status).toBe('ok')
  })

  it('S3 down is reported but does NOT flag overall-down (non-gating)', async () => {
    // S3 backs uploads/backups, not the core doc path — an S3 blip must
    // not 503 the node out of Traefik rotation. It IS still visible.
    mockState.s3Send = async () => {
      throw new Error('connection reset')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const r = await runAllProbes({
      syncUrl: 'http://sync:4001',
      rendererUrl: 'http://renderer:9000',
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000',
      s3Bucket: 'markoto-bucket'
    })
    expect(r.s3.status).toBe('down')
    expect(isOverallHealthy(r)).toBe(true)
  })

  it('getCachedProbeResults shares the fan-out with getCachedHealth (one round)', async () => {
    _resetHealthCache()
    const dbSpy = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }))
    mockState.dbExecute = dbSpy
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch(200))
    const urls = {
      syncUrl: 'http://sync',
      rendererUrl: 'http://renderer',
      markitdownUrl: 'http://md',
      litellmUrl: 'http://litellm:4000',
      s3Bucket: 'markoto-bucket'
    }
    const health = await getCachedHealth(urls)
    const results = await getCachedProbeResults(urls)
    expect(health.status).toBe(200)
    expect(results.s3.status).toBe('ok')
    // Both reads served from one cached fan-out.
    expect(dbSpy).toHaveBeenCalledTimes(1)
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
      markitdownUrl: 'http://md',
      litellmUrl: 'http://litellm:4000'
    })
    const r2 = await getCachedHealth({
      syncUrl: 'http://sync',
      rendererUrl: 'http://renderer',
      markitdownUrl: 'http://md',
      litellmUrl: 'http://litellm:4000'
    })

    expect(r1).toBe(r2) // same cached object
    expect(r1.status).toBe(200)
    expect(dbSpy).toHaveBeenCalledTimes(1)
    expect(valkeySpy).toHaveBeenCalledTimes(1)
    // 4 HTTP probes per round (sync, renderer, markitdown, litellm).
    expect(fetchSpy).toHaveBeenCalledTimes(4)
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
      markitdownUrl: 'http://md',
      litellmUrl: 'http://litellm:4000'
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
      markitdownUrl: 'http://markitdown:8080',
      litellmUrl: 'http://litellm:4000'
    })
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(250)
  })
})
