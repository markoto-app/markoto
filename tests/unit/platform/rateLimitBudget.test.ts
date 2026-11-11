import { describe, it, expect, beforeEach, vi } from 'vitest'

// Rate-limit budget + session lock behavior. These exist as cheap
// regression tests — the functions look trivial but carry two
// subtle design choices we don't want to lose:
//   1. `consumeRateLimitBudget` fails OPEN on Valkey errors (returns
//      allowed:true). That's deliberate — a wedged Valkey must not
//      DoS the app, which would be worse than letting a rate limit
//      leak briefly.
//   2. `tryAcquireSessionLock` fails CLOSED (returns false). A
//      concurrent-session CAP, not a rate limit — failing open would
//      let unlimited sessions through and double-bill GCP.
// A refactor that accidentally flips either polarity would be
// silently dangerous; these tests pin the contract.

// In-memory fake of the subset of ioredis we use. Enough to model
// SET NX PX / DEL for the session lock, plus a throwing `eval` for the
// budget helper's fail-open path.
class FakeValkey {
  store = new Map<string, string>()
  ttls = new Map<string, number>()
  throwOnNext: Error | null = null

  async get(key: string): Promise<string | null> {
    if (this.throwOnNext) {
      const e = this.throwOnNext
      this.throwOnNext = null
      throw e
    }
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, mode?: string, ttl?: number, flag?: string): Promise<string | null> {
    if (this.throwOnNext) {
      const e = this.throwOnNext
      this.throwOnNext = null
      throw e
    }
    // Emulate the SET key val PX ttl NX syntax our code uses.
    const nx = flag === 'NX' || mode === 'NX'
    if (nx && this.store.has(key)) return null
    this.store.set(key, value)
    if (mode === 'PX' && typeof ttl === 'number') this.ttls.set(key, ttl)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) ? 1 : 0
    this.ttls.delete(key)
    return had
  }

  async eval(): Promise<unknown> {
    if (this.throwOnNext) {
      const e = this.throwOnNext
      this.throwOnNext = null
      throw e
    }
    // The budget debit is a Lua script executed inside Valkey; its
    // semantics (cap, peek, no debit on reject, concurrency) are tested
    // against the real Valkey test container in
    // tests/repos/rateLimitAtomic.test.ts. Only the fail-open path is
    // modelled here.
    throw new Error('eval() not modeled in FakeValkey')
  }
}

const fake = new FakeValkey()

// Nitro exposes `useRuntimeConfig` / `useValkey` as globals via its
// auto-imports; in unit tests we replace with the fake. We do the
// mock via `vi.mock` at the top level so imports of rateLimit.ts
// pick it up.
vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: () => fake
}))

// Also silence the TEST_MODE short-circuit inside rateLimit.ts — the
// helpers bail out in TEST_MODE and return defaults. For these tests
// we WANT to exercise the real logic, so toggle env before import.
// Vitest hoists vi.mock above the import order; env must be set
// before the module is evaluated.
process.env.TEST_MODE = '0'

// Import AFTER env + mock setup.

const { consumeRateLimitBudget, tryAcquireSessionLock, releaseSessionLock } = await import('../../../server/utils/platform/rateLimit')

describe('consumeRateLimitBudget', () => {
  beforeEach(() => {
    fake.store.clear()
    fake.ttls.clear()
    fake.throwOnNext = null
  })

  it('fails OPEN on Valkey errors', async () => {
    // Defense-in-depth: a wedged Valkey must not DoS the app. The
    // function surfaces the error to Sentry (not asserted here) but
    // lets the request through.
    fake.throwOnNext = new Error('valkey down')
    const r = await consumeRateLimitBudget('ns', 'u', 100, 1000, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(1000)
  })
})

describe('tryAcquireSessionLock', () => {
  beforeEach(() => {
    fake.store.clear()
    fake.ttls.clear()
    fake.throwOnNext = null
  })

  it('first acquire returns true', async () => {
    expect(await tryAcquireSessionLock('dictate', 'user-1', 10_000)).toBe(true)
  })

  it('second acquire while the first is held returns false', async () => {
    expect(await tryAcquireSessionLock('dictate', 'user-1', 10_000)).toBe(true)
    expect(await tryAcquireSessionLock('dictate', 'user-1', 10_000)).toBe(false)
  })

  it('sets the TTL on acquire', async () => {
    await tryAcquireSessionLock('dictate', 'u', 12_345)
    expect(fake.ttls.get('lock:dictate:u')).toBe(12_345)
  })

  it('releaseSessionLock frees the slot', async () => {
    expect(await tryAcquireSessionLock('dictate', 'u', 10_000)).toBe(true)
    await releaseSessionLock('dictate', 'u')
    expect(await tryAcquireSessionLock('dictate', 'u', 10_000)).toBe(true)
  })

  it('fails CLOSED on Valkey errors', async () => {
    // Inverse of the budget helper — failing open would let unlimited
    // concurrent sessions through during a Valkey blip and silently
    // double-bill GCP.
    fake.throwOnNext = new Error('valkey down')
    expect(await tryAcquireSessionLock('dictate', 'u', 10_000)).toBe(false)
  })

  it('isolates locks by user', async () => {
    expect(await tryAcquireSessionLock('dictate', 'user-1', 10_000)).toBe(true)
    expect(await tryAcquireSessionLock('dictate', 'user-2', 10_000)).toBe(true)
    // user-1 still locked; user-2 independently locked.
    expect(await tryAcquireSessionLock('dictate', 'user-1', 10_000)).toBe(false)
    expect(await tryAcquireSessionLock('dictate', 'user-2', 10_000)).toBe(false)
  })
})
