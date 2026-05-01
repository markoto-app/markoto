import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Fail-mode regression tests for `server/utils/rateLimit.ts`.
//
// The file documents two opposing fail-modes per helper, and a refactor
// could silently flip the polarity. We pin them down here:
//
//   fails OPEN  →  checkRateLimit, consumeRateLimitBudget
//                  (DoS protection only — a wedged Valkey must not
//                  refuse otherwise-valid requests)
//   fails CLOSED → tryAcquireSessionLock, reserveInflightSlot
//                  (correctness caps — failing open re-opens races
//                  or admits over-cap concurrent sessions)
//   best-effort  → releaseSessionLock, releaseInflightSlot
//                  (TTL handles cleanup if the call throws)
//
// We also pin which helpers honour the TEST_MODE bypass — the
// fail-OPEN ones do (so the integration suite can pound endpoints
// without a real Valkey), and the lock helpers explicitly do NOT
// (so tests can verify lock acquire/release).

// vi.mock factories are hoisted to the top of the file by vitest
// alongside any nested vi.fn() — we can keep imports in their natural
// position and grab the spy back via vi.mocked after import.
import * as Sentry from '@sentry/nuxt'
import { useValkey } from '../../server/utils/valkey'
import {
  checkRateLimit,
  consumeRateLimitBudget,
  tryAcquireSessionLock,
  releaseSessionLock,
  reserveInflightSlot,
  releaseInflightSlot
} from '../../server/utils/rateLimit'

vi.mock('@sentry/nuxt', () => ({
  captureException: vi.fn()
}))

vi.mock('../../server/utils/valkey', () => ({
  useValkey: vi.fn()
}))

const captureException = vi.mocked(Sentry.captureException)

// Build a minimal Valkey-shaped object. Every method our code touches
// is present; tests override with `overrides` for the specific call
// they're exercising. Methods left at the defaults return innocuous
// success values so a stray call doesn't accidentally throw.
type ValkeyShape = {
  multi: () => unknown
  set: (...args: unknown[]) => Promise<unknown>
  get: (key: string) => Promise<string | null>
  incr: (key: string) => Promise<number>
  incrby: (key: string, by: number) => Promise<number>
  decr: (key: string) => Promise<number>
  pexpire: (key: string, ttl: number) => Promise<number>
  del: (key: string) => Promise<number>
}

// Sync thrower factory — used to simulate Valkey errors on the
// non-async `multi()` callsite. Defining it once avoids the
// `max-statements-per-line` lint that fires on inline
// `() => { throw new Error() }` constructs.
function syncThrow(message: string): () => never {
  return () => {
    throw new Error(message)
  }
}

// Async thrower factory — same idea for `async () => { throw ... }`
// callsites (get/set/decr/...).
function asyncThrow(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message))
}

function mockValkey(overrides: Partial<ValkeyShape> = {}): ValkeyShape {
  const defaultPipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => [[null, 0], [null, 0]])
  }
  const client: ValkeyShape = {
    multi: () => defaultPipeline,
    set: async () => 'OK',
    get: async () => null,
    incr: async () => 1,
    incrby: async () => 1,
    decr: async () => 0,
    pexpire: async () => 1,
    del: async () => 1,
    ...overrides
  }
  vi.mocked(useValkey).mockReturnValue(client as unknown as ReturnType<typeof useValkey>)
  return client
}

const ORIGINAL_TEST_MODE = process.env.TEST_MODE

beforeEach(() => {
  // Disable the TEST_MODE short-circuit so we can reach the real
  // Valkey-call paths. Individual tests that want to verify the
  // bypass re-enable it inline.
  delete process.env.TEST_MODE
  captureException.mockClear()
  vi.mocked(useValkey).mockReset()
})

afterEach(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE
})

describe('checkRateLimit (fails OPEN)', () => {
  it('returns true when Valkey throws on multi() — request allowed despite Valkey down', async () => {
    mockValkey({ multi: syncThrow('ECONNREFUSED') })
    const ok = await checkRateLimit('test', 'key', 5, 60_000)
    expect(ok).toBe(true)
  })

  it('returns true when valkey.exec returns null (transaction discarded)', async () => {
    const pipeline = {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => null)
    }
    mockValkey({ multi: () => pipeline })
    const ok = await checkRateLimit('test', 'key', 5, 60_000)
    expect(ok).toBe(true)
  })

  it('Sentry-captures the Valkey error with component/event/namespace tags', async () => {
    mockValkey({ multi: syncThrow('ECONNREFUSED') })
    await checkRateLimit('test-namespace', 'key', 5, 60_000)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          component: 'rateLimit',
          event: 'valkey_unavailable',
          namespace: 'test-namespace'
        })
      })
    )
  })

  it('returns false when count is at or above maxAttempts', async () => {
    const writePipeline = {
      zadd: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 1], [null, 1]])
    }
    const readPipeline = {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 5]])
    }
    let nthCall = 0
    mockValkey({
      multi: () => (nthCall++ === 0 ? readPipeline : writePipeline)
    })
    expect(await checkRateLimit('test', 'key', 5, 60_000)).toBe(false)
  })
})

describe('consumeRateLimitBudget (fails OPEN)', () => {
  it('returns allowed=true with full remaining when Valkey throws', async () => {
    mockValkey({ get: asyncThrow('boom') })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(1000)
  })

  it('Sentry-captures the Valkey error', async () => {
    mockValkey({ get: asyncThrow('boom') })
    await consumeRateLimitBudget('ns', 'key', 100, 1000, 60_000)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          component: 'rateLimit',
          event: 'valkey_unavailable',
          namespace: 'ns'
        })
      })
    )
  })

  it('returns allowed=false when current+cost exceeds maxCost (no Valkey error)', async () => {
    mockValkey({ get: async () => '950' })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(50)
  })

  it('debits and refreshes TTL on a normal allowed call', async () => {
    const incrby = vi.fn(async () => 200)
    const pexpire = vi.fn(async () => 1)
    mockValkey({ get: async () => '100', incrby, pexpire })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(800)
    expect(incrby).toHaveBeenCalled()
    expect(pexpire).toHaveBeenCalled()
  })
})

describe('tryAcquireSessionLock (fails CLOSED)', () => {
  it('returns false when Valkey throws — fail-closed: do not proceed without the lock', async () => {
    mockValkey({ set: asyncThrow('ECONNREFUSED') })
    const ok = await tryAcquireSessionLock('dictate', 'user-42', 60_000)
    expect(ok).toBe(false)
  })

  it('Sentry-captures the Valkey error', async () => {
    mockValkey({ set: asyncThrow('boom') })
    await tryAcquireSessionLock('dictate', 'user-42', 60_000)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          component: 'rateLimit',
          event: 'valkey_unavailable',
          namespace: 'dictate'
        })
      })
    )
  })

  it('returns true on a normal SET NX EX response of "OK"', async () => {
    mockValkey({ set: async () => 'OK' })
    expect(await tryAcquireSessionLock('dictate', 'user-42', 60_000)).toBe(true)
  })

  it('returns false when SET NX EX returns null (lock already held)', async () => {
    mockValkey({ set: async () => null })
    expect(await tryAcquireSessionLock('dictate', 'user-42', 60_000)).toBe(false)
  })

  it('does NOT honour TEST_MODE bypass — must always exercise the real Valkey path', async () => {
    process.env.TEST_MODE = '1'
    // simulate lock already held; even with TEST_MODE the function
    // must still call SET NX EX and surface the null response.
    mockValkey({ set: async () => null })
    expect(await tryAcquireSessionLock('dictate', 'user-42', 60_000)).toBe(false)
  })
})

describe('releaseSessionLock (best-effort)', () => {
  it('swallows Valkey errors silently — TTL is the safety net', async () => {
    mockValkey({ del: asyncThrow('boom') })
    await expect(releaseSessionLock('dictate', 'user-42')).resolves.toBeUndefined()
  })

  it('does NOT honour TEST_MODE bypass — must call DEL even under TEST_MODE so lock truly clears in tests', async () => {
    process.env.TEST_MODE = '1'
    const del = vi.fn(async () => 1)
    mockValkey({ del })
    await releaseSessionLock('dictate', 'user-42')
    expect(del).toHaveBeenCalledWith('lock:dictate:user-42')
  })

  it('issues DEL on the namespaced lock key under normal conditions', async () => {
    const del = vi.fn(async () => 1)
    mockValkey({ del })
    await releaseSessionLock('dictate', 'user-42')
    expect(del).toHaveBeenCalledWith('lock:dictate:user-42')
  })
})

describe('reserveInflightSlot (fails CLOSED)', () => {
  it('returns allowed=false on Valkey error — failing open would re-open the cap race', async () => {
    mockValkey({ get: asyncThrow('boom') })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.current).toBe(0)
  })

  it('Sentry-captures the Valkey error', async () => {
    mockValkey({ get: asyncThrow('boom') })
    await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          component: 'rateLimit',
          event: 'valkey_unavailable',
          namespace: 'upload'
        })
      })
    )
  })

  it('returns allowed=false when at cap (no Valkey error)', async () => {
    mockValkey({ get: async () => '5' })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.current).toBe(5)
  })

  it('increments the counter and refreshes TTL on success', async () => {
    const incr = vi.fn(async () => 3)
    const pexpire = vi.fn(async () => 1)
    mockValkey({ get: async () => '2', incr, pexpire })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.current).toBe(3)
    expect(incr).toHaveBeenCalled()
    expect(pexpire).toHaveBeenCalled()
  })
})

describe('releaseInflightSlot (best-effort)', () => {
  it('swallows Valkey errors silently', async () => {
    mockValkey({ decr: asyncThrow('boom') })
    await expect(releaseInflightSlot('upload', 'ws-1')).resolves.toBeUndefined()
  })

  it('deletes the key when the post-DECR value reaches zero (clamps negative)', async () => {
    const del = vi.fn(async () => 1)
    mockValkey({ decr: async () => 0, del })
    await releaseInflightSlot('upload', 'ws-1')
    expect(del).toHaveBeenCalledWith('inflight:upload:ws-1')
  })
})

describe('TEST_MODE bypass — honoured by fail-OPEN helpers, NOT by lock helpers', () => {
  it('checkRateLimit returns true under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const client = mockValkey()
    const multiSpy = vi.spyOn(client, 'multi')
    expect(await checkRateLimit('any', 'any', 1, 1)).toBe(true)
    expect(multiSpy).not.toHaveBeenCalled()
  })

  it('consumeRateLimitBudget returns allowed=true with maxCost remaining without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const get = vi.fn()
    mockValkey({ get })
    const r = await consumeRateLimitBudget('any', 'any', 50, 500, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(500)
    expect(get).not.toHaveBeenCalled()
  })

  it('reserveInflightSlot returns allowed=true under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const get = vi.fn()
    mockValkey({ get })
    const r = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.current).toBe(0)
    expect(get).not.toHaveBeenCalled()
  })

  it('releaseInflightSlot returns under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const decr = vi.fn()
    mockValkey({ decr })
    await expect(releaseInflightSlot('upload', 'ws-1')).resolves.toBeUndefined()
    expect(decr).not.toHaveBeenCalled()
  })
})
