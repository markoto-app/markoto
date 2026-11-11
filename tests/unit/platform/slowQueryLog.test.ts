import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tests for Item 2 — slow-query log instrumentation in
// server/utils/platform/database.ts. We can't import the real `useDatabase`
// because it spins up an actual Pool against a real DB; instead we
// stub `pg.Pool` for a fake whose `query` method we control, then run
// the wrapped pool's `query` and observe Sentry side effects.

const captureMessage = vi.fn<(msg: string, opts?: unknown) => void>()
vi.mock('@sentry/nuxt', () => ({
  captureMessage,
  captureException: vi.fn()
}))

// Force a low threshold so the test's artificial delay clears it.
process.env.NUXT_DB_SLOW_QUERY_MS = '5'

// Stub `pg` Pool. Use a real class so `new Pool(...)` works (vi.fn
// returning an instance has constructor-detection edge cases under
// Vitest's V8 isolate). The fake's `query` is preset BEFORE the
// instrumentation runs, so the wrapper captures THIS implementation
// when it calls `.bind(pool)`.
class FakePool {
  query: (...args: unknown[]) => Promise<unknown>
  constructor() {
    this.query = async () => ({ rows: [] })
  }
}
let lastPool: FakePool | null = null

vi.mock('pg', () => {
  return {
    Pool: class extends FakePool {
      constructor(_cfg: unknown) {
        super()
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self: FakePool = this
        lastPool = self
      }
    }
  }
})

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({})
}))

vi.mock('../../../shared/utils/runtime/connectionStrings', () => ({
  postgresUrlFromEnv: () => 'postgres://test'
}))

vi.mock('../../../server/db/schema', () => ({}))

beforeEach(() => {
  captureMessage.mockReset()
  vi.resetModules()
  lastPool = null
})

describe('slow-query log', () => {
  it('does not fire for fast queries', async () => {
    const { useDatabase } = await import('../../../server/utils/platform/database')
    useDatabase()
    const pool = lastPool!
    expect(pool).toBeTruthy()
    await pool.query('SELECT 1')
    await pool.query('SELECT 2', [1, 2, 3])
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('fires a warning-level Sentry event with truncated SQL when a query exceeds the threshold', async () => {
    // performance.now is what the wrapper uses to measure duration.
    // Spy returns 0 then 200ms — the wrapper computes `200 - 0 = 200`,
    // which exceeds the 5ms threshold and fires Sentry.
    let nowCalls = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      nowCalls += 1
      return nowCalls === 1 ? 0 : 200
    })
    try {
      const { useDatabase } = await import('../../../server/utils/platform/database')
      useDatabase()
      const pool = lastPool!
      const longSql = 'SELECT '.padEnd(800, 'x')
      await pool.query(longSql, ['secret-password', 'pii@example.com'])
      expect(captureMessage).toHaveBeenCalledTimes(1)
      const [name, opts] = captureMessage.mock.calls[0]!
      expect(name).toBe('slow-query')
      const o = opts as { level: string, tags: Record<string, string>, extra: Record<string, unknown> }
      expect(o.level).toBe('warning')
      expect(o.tags).toMatchObject({ component: 'db', event: 'slow_query' })
      // SQL truncated.
      expect((o.extra.sql as string).length).toBe(500)
      // paramsCount only — never the values themselves.
      expect(o.extra.paramsCount).toBe(2)
      const serialized = JSON.stringify(o.extra)
      expect(serialized).not.toContain('secret-password')
      expect(serialized).not.toContain('pii@example.com')
      expect(o.extra.durationMs).toBe(200)
      expect(o.extra.thresholdMs).toBe(5)
    } finally {
      spy.mockRestore()
    }
  })

  it('reads SQL + paramsCount from a QueryConfig object form', async () => {
    let nowCalls = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      nowCalls += 1
      return nowCalls === 1 ? 0 : 50
    })
    try {
      const { useDatabase } = await import('../../../server/utils/platform/database')
      useDatabase()
      const pool = lastPool!
      // QueryConfig form — { text, values } — used by Drizzle internally.
      await pool.query({ text: 'UPDATE foo SET bar = $1', values: ['baz'] })
      expect(captureMessage).toHaveBeenCalledTimes(1)
      const [, opts] = captureMessage.mock.calls[0]!
      const extra = (opts as { extra: Record<string, unknown> }).extra
      expect(extra.sql).toBe('UPDATE foo SET bar = $1')
      expect(extra.paramsCount).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
