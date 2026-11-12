import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deliberatelyInvalid } from '../../helpers/fixtures'

// LiteLLM_SpendLogs retention sweeper. The 90-day cutoff is the
// load-bearing arithmetic — off by one means we delete a day too
// much (forensic gap) or too little (table grows). These tests
// pin both the date math and the failure-tolerant shape (a Postgres
// hiccup leaves rows around for the next cycle, doesn't crash the
// plugin loop).

const queryFn = vi.fn<(sql: string, params: unknown[]) => Promise<{ rowCount: number }>>()
const endFn = vi.fn<() => Promise<void>>()
const PoolMock = vi.fn(function (this: { query: typeof queryFn, end: typeof endFn }) {
  this.query = queryFn
  this.end = endFn
})

vi.mock('pg', () => ({ Pool: PoolMock }))

vi.mock('@sentry/nuxt', () => ({
  captureMessage: vi.fn()
}))

const {
  runSpendLogsSweep,
  _resetSpendLogsSweepPool
} = await import('../../../server/utils/litellm/spendLogsSweep')

beforeEach(() => {
  queryFn.mockReset()
  endFn.mockReset()
  PoolMock.mockClear()
  _resetSpendLogsSweepPool()
})

afterEach(() => {
  _resetSpendLogsSweepPool()
})

describe('runSpendLogsSweep — date math', () => {
  it('uses a 90-day cutoff against the LiteLLM_SpendLogs.startTime column', async () => {
    queryFn.mockResolvedValueOnce({ rowCount: 42 })

    const before = Date.now()
    const result = await runSpendLogsSweep()
    const after = Date.now()

    expect(result).toEqual({ deleted: 42 })
    expect(queryFn).toHaveBeenCalledTimes(1)

    const [sql, params] = queryFn.mock.calls[0]!
    // SQL targets the right table + column; quoted PascalCase is
    // load-bearing because Prisma stores them that way.
    expect(sql).toContain('"LiteLLM_SpendLogs"')
    expect(sql).toContain('"startTime"')
    expect(sql).toContain('DELETE')

    // Cutoff is exactly 90 days before "now" (within the test window).
    const cutoffIso = params[0] as string
    expect(typeof cutoffIso).toBe('string')
    const cutoffMs = new Date(cutoffIso).getTime()
    const expectedMin = before - 90 * 24 * 60 * 60 * 1000
    const expectedMax = after - 90 * 24 * 60 * 60 * 1000
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedMin)
    expect(cutoffMs).toBeLessThanOrEqual(expectedMax)
  })

  it('returns deleted=0 when the table is empty (rowCount=0)', async () => {
    queryFn.mockResolvedValueOnce({ rowCount: 0 })
    const result = await runSpendLogsSweep()
    expect(result).toEqual({ deleted: 0 })
  })

  it('handles null rowCount (some pg drivers return null on DELETE without rows) as 0', async () => {
    queryFn.mockResolvedValueOnce(deliberatelyInvalid({ rowCount: null }))
    const result = await runSpendLogsSweep()
    expect(result).toEqual({ deleted: 0 })
  })
})

describe('runSpendLogsSweep — failure tolerance', () => {
  it('returns null + warns when the DB query throws (does NOT throw)', async () => {
    queryFn.mockRejectedValueOnce(new Error('connection refused'))
    const result = await runSpendLogsSweep()
    // Sweeper is fire-and-forget; a Postgres hiccup just leaves rows
    // around for the next cycle. Throwing would crash the plugin
    // setInterval loop and silently kill the daily sweep.
    expect(result).toBeNull()
  })

  it('reuses the cached pool across calls (single connection)', async () => {
    queryFn.mockResolvedValue({ rowCount: 0 })
    await runSpendLogsSweep()
    await runSpendLogsSweep()
    await runSpendLogsSweep()
    // 3 query calls, but only 1 Pool constructed.
    expect(PoolMock).toHaveBeenCalledTimes(1)
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('_resetSpendLogsSweepPool drops the cache so a fresh Pool is built next call', async () => {
    queryFn.mockResolvedValue({ rowCount: 0 })
    await runSpendLogsSweep()
    expect(PoolMock).toHaveBeenCalledTimes(1)
    _resetSpendLogsSweepPool()
    await runSpendLogsSweep()
    expect(PoolMock).toHaveBeenCalledTimes(2)
  })
})
