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
// GET/INCRBY/SET NX PX/DEL/multi pipelines.
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

  async incrby(key: string, by: number): Promise<number> {
    const cur = Number(this.store.get(key) ?? '0')
    const next = cur + by
    this.store.set(key, String(next))
    return next
  }

  async pexpire(key: string, ttl: number): Promise<number> {
    this.ttls.set(key, ttl)
    return 1
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) ? 1 : 0
    this.ttls.delete(key)
    return had
  }

  multi() {
    // We don't exercise multi() in the paths under test (those live in
    // `checkRateLimit`, not the budget helpers), so a minimal stub is
    // fine — throws if accidentally called so a future code change
    // that routes through multi gets a visible regression.
    throw new Error('multi() not modeled in FakeValkey')
  }
}

const fake = new FakeValkey()

// Nitro exposes `useRuntimeConfig` / `useValkey` as globals via its
// auto-imports; in unit tests we replace with the fake. We do the
// mock via `vi.mock` at the top level so imports of rateLimit.ts
// pick it up.
vi.mock('../../server/utils/valkey', () => ({
  useValkey: () => fake
}))

// Also silence the TEST_MODE short-circuit inside rateLimit.ts — the
// helpers bail out in TEST_MODE and return defaults. For these tests
// we WANT to exercise the real logic, so toggle env before import.
// Vitest hoists vi.mock above the import order; env must be set
// before the module is evaluated.
process.env.TEST_MODE = '0'

// Import AFTER env + mock setup.

const { consumeRateLimitBudget, tryAcquireSessionLock, releaseSessionLock } = await import('../../server/utils/rateLimit')

describe('consumeRateLimitBudget', () => {
  beforeEach(() => {
    fake.store.clear()
    fake.ttls.clear()
    fake.throwOnNext = null
  })

  it('allows a cost under the cap and debits it', async () => {
    const r = await consumeRateLimitBudget('test', 'user-1', 100, 1000, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(900)
  })

  it('rejects costs that would exceed the cap WITHOUT debiting', async () => {
    await consumeRateLimitBudget('test', 'user-1', 900, 1000, 60_000)
    // Second call: 900 (spent) + 200 (would-be cost) > 1000 (cap).
    const r = await consumeRateLimitBudget('test', 'user-1', 200, 1000, 60_000)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(100) // unchanged from the rejection
    // Verify no debit happened — bucket still at 900.
    const peek = await consumeRateLimitBudget('test', 'user-1', 0, 1000, 60_000)
    expect(peek.remaining).toBe(100)
  })

  it('accumulates across calls within the window', async () => {
    await consumeRateLimitBudget('ns', 'u', 300, 1000, 60_000)
    await consumeRateLimitBudget('ns', 'u', 300, 1000, 60_000)
    const r = await consumeRateLimitBudget('ns', 'u', 300, 1000, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(100)
  })

  it('zero cost returns the actual remaining without debiting — peek mode', async () => {
    // cost:0 is used by session-open paths to decide whether a user
    // is already exhausted before starting. Must return the REAL
    // remaining (maxCost - current), not a naive maxCost — otherwise
    // exhausted users would always pass the open-time check and only
    // trip on the first audio chunk (open-then-close flicker).
    await consumeRateLimitBudget('ns', 'u', 400, 1000, 60_000)
    const peek = await consumeRateLimitBudget('ns', 'u', 0, 1000, 60_000)
    expect(peek.allowed).toBe(true)
    expect(peek.remaining).toBe(600) // 1000 cap − 400 already spent
    // Verify peek did NOT debit — another peek still reads 600.
    const peek2 = await consumeRateLimitBudget('ns', 'u', 0, 1000, 60_000)
    expect(peek2.remaining).toBe(600)
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

  it('isolates buckets by namespace', async () => {
    await consumeRateLimitBudget('a', 'u', 900, 1000, 60_000)
    // Different namespace = different bucket; should have full budget.
    const r = await consumeRateLimitBudget('b', 'u', 900, 1000, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(100)
  })

  it('isolates buckets by key (per-user)', async () => {
    await consumeRateLimitBudget('ns', 'user-1', 900, 1000, 60_000)
    const r = await consumeRateLimitBudget('ns', 'user-2', 900, 1000, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(100)
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
