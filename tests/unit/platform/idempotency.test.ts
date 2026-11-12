import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { deliberatelyInvalid } from '../../helpers/fixtures'

// Idempotency helper. Pins three load-bearing properties:
//   1. Header absent → behave as a no-op pass-through (don't break
//      callers that don't opt in).
//   2. Same key + same user + same scope twice → second call returns
//      the FIRST result without calling fn again.
//   3. Different user / different scope → no collision.
//   4. While the first call is in flight, a second call to the same
//      key returns 409 (placeholder sentinel logic).
//   5. fn throws → placeholder is dropped so retries can re-attempt.

// In-memory ioredis-shaped fake. Models GET/SET (with NX/EX)/DEL —
// nothing else; idempotency.ts uses no other commands.
class FakeValkey {
  store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  // Match ioredis's variadic call: set(key, value, 'EX', seconds, 'NX')
  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    const wantsNx = args.includes('NX')
    if (wantsNx && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }
}

const fake = new FakeValkey()

vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: () => fake
}))

// Stub h3's createError as a Nitro-shaped Error so the helper can
// throw without pulling Nitro into the unit test process.
const headerStore: { value: string | undefined } = { value: undefined }

;(globalThis as unknown as { getRequestHeader: Mock }).getRequestHeader = vi.fn(
  (_event: unknown, name: string) => name.toLowerCase() === 'idempotency-key' ? headerStore.value : undefined
)
;(globalThis as unknown as { createError: Mock }).createError = vi.fn((opts: { statusCode?: number, message?: string, statusMessage?: string, data?: unknown }) => {
  const e = new Error(opts.message ?? opts.statusMessage ?? 'Error') as Error & { statusCode?: number, data?: unknown }
  e.statusCode = opts.statusCode
  e.data = opts.data
  return e
})

const { withIdempotency } = await import('../../../server/utils/platform/idempotency')

const FAKE_EVENT = deliberatelyInvalid({}) // helper only forwards to getRequestHeader

beforeEach(() => {
  fake.store.clear()
  headerStore.value = undefined
})

describe('withIdempotency', () => {
  it('header absent → pass-through, never touches Valkey', async () => {
    headerStore.value = undefined
    const fn = vi.fn(async () => ({ docId: 'fresh' }))
    const r = await withIdempotency(FAKE_EVENT, 'duplicate:src', 1, fn)
    expect(r).toEqual({ docId: 'fresh' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fake.store.size).toBe(0)
  })

  it('rejects malformed Idempotency-Key (too short)', async () => {
    headerStore.value = 'short'
    const fn = vi.fn(async () => ({ docId: 'x' }))
    await expect(withIdempotency(FAKE_EVENT, 'duplicate:src', 1, fn))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('first call runs fn, second call with same key returns cached result', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-1'
    let counter = 0
    const fn = vi.fn(async () => ({ docId: `doc-${++counter}` }))

    const r1 = await withIdempotency(FAKE_EVENT, 'duplicate:src', 42, fn)
    const r2 = await withIdempotency(FAKE_EVENT, 'duplicate:src', 42, fn)

    expect(r1).toEqual({ docId: 'doc-1' })
    expect(r2).toEqual({ docId: 'doc-1' }) // SAME response — fn not re-run
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('different users with the same key do not collide', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-2'
    const fn1 = vi.fn(async () => ({ docId: 'user-1-doc' }))
    const fn2 = vi.fn(async () => ({ docId: 'user-2-doc' }))

    const r1 = await withIdempotency(FAKE_EVENT, 'duplicate:src', 1, fn1)
    const r2 = await withIdempotency(FAKE_EVENT, 'duplicate:src', 2, fn2)

    expect(r1).toEqual({ docId: 'user-1-doc' })
    expect(r2).toEqual({ docId: 'user-2-doc' })
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('different scopes with the same key do not collide', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-3'
    const fnA = vi.fn(async () => ({ docId: 'scope-a' }))
    const fnB = vi.fn(async () => ({ docId: 'scope-b' }))

    const rA = await withIdempotency(FAKE_EVENT, 'duplicate:src-a', 1, fnA)
    const rB = await withIdempotency(FAKE_EVENT, 'duplicate:src-b', 1, fnB)

    expect(rA).toEqual({ docId: 'scope-a' })
    expect(rB).toEqual({ docId: 'scope-b' })
  })

  it('in-flight collision throws 409', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-4'

    // Manually plant the placeholder to simulate "another worker is mid-flight".
    fake.store.set('idempotent:duplicate:src:7:aaaaaaaaaaaaaaaa-key-4', 'pending:')

    const fn = vi.fn(async () => ({ docId: 'should-not-run' }))
    await expect(withIdempotency(FAKE_EVENT, 'duplicate:src', 7, fn))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('fn throws → placeholder dropped, retry succeeds', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-5'
    const failOnce = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ docId: 'second-try' })

    await expect(withIdempotency(FAKE_EVENT, 'duplicate:src', 1, failOnce))
      .rejects.toThrow('boom')

    // The placeholder must be gone — otherwise the retry would 409.
    const r = await withIdempotency(FAKE_EVENT, 'duplicate:src', 1, failOnce)
    expect(r).toEqual({ docId: 'second-try' })
    expect(failOnce).toHaveBeenCalledTimes(2)
  })

  it('corrupt cached envelope falls back to a fresh run', async () => {
    headerStore.value = 'aaaaaaaaaaaaaaaa-key-6'
    fake.store.set('idempotent:duplicate:src:1:aaaaaaaaaaaaaaaa-key-6', '{not json')

    const fn = vi.fn(async () => ({ docId: 'rebuilt' }))
    const r = await withIdempotency(FAKE_EVENT, 'duplicate:src', 1, fn)
    expect(r).toEqual({ docId: 'rebuilt' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
