import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Fail-mode regression tests for `server/utils/platform/rateLimit.ts`.
//
// The file documents two opposing fail-modes per helper, and a refactor
// could silently flip the polarity. We pin them down here:
//
//   fails OPEN  →  checkRateLimit, consumeRateLimitBudget
//                  (DoS protection only: a wedged Valkey must not
//                  refuse otherwise-valid requests)
//   fails CLOSED → tryAcquireSessionLock, reserveInflightSlot
//                  (correctness caps: failing open re-opens races
//                  or admits over-cap concurrent sessions)
//   best-effort  → releaseSessionLock, releaseInflightSlot
//                  (TTL handles cleanup if the call throws)
//
// We also pin which helpers honour the TEST_MODE bypass, the
// fail-OPEN ones do (so the integration suite can pound endpoints
// without a real Valkey), and the lock helpers explicitly do NOT
// (so tests can verify lock acquire/release).

// vi.mock factories are hoisted to the top of the file by vitest
// alongside any nested vi.fn(), we can keep imports in their natural
// position and grab the spy back via vi.mocked after import.
import * as Sentry from '@sentry/nuxt'
import { useValkey } from '../../../server/utils/platform/valkey'
import {
  checkRateLimit,
  consumeRateLimitBudget,
  tryAcquireSessionLock,
  releaseSessionLock,
  reserveInflightSlot,
  releaseInflightSlot
} from '../../../server/utils/platform/rateLimit'

vi.mock('@sentry/nuxt', () => ({
  captureException: vi.fn()
}))

vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: vi.fn()
}))

const captureException = vi.mocked(Sentry.captureException)

// Build a minimal Valkey-shaped object. Every method our code touches
// is present; tests override with `overrides` for the specific call
// they're exercising. Methods left at the defaults return innocuous
// success values so a stray call doesn't accidentally throw.
type ValkeyShape = {
  eval: (...args: unknown[]) => Promise<unknown>
  set: (...args: unknown[]) => Promise<unknown>
  get: (key: string) => Promise<string | null>
  decr: (key: string) => Promise<number>
  del: (key: string) => Promise<number>
}

// Async thrower factory: used to simulate Valkey errors on the
// async callsites (eval/set/decr/...).
function asyncThrow(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message))
}

function mockValkey(overrides: Partial<ValkeyShape> = {}): ValkeyShape {
  const client: ValkeyShape = {
    eval: async () => 1,
    set: async () => 'OK',
    get: async () => null,
    decr: async () => 0,
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
  it('returns true when the Valkey script call throws, request allowed despite Valkey down', async () => {
    mockValkey({ eval: asyncThrow('ECONNREFUSED') })
    const ok = await checkRateLimit('test', 'key', 5, 60_000)
    expect(ok).toBe(true)
  })

  it('Sentry-captures the Valkey error with component/event/namespace tags', async () => {
    mockValkey({ eval: asyncThrow('ECONNREFUSED') })
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

  it('returns false when the script reports the limit is reached', async () => {
    mockValkey({ eval: async () => 0 })
    expect(await checkRateLimit('test', 'key', 5, 60_000)).toBe(false)
  })

  it('checks and records in ONE script call on the namespaced key (atomic)', async () => {
    const evalSpy = vi.fn(async () => 1)
    mockValkey({ eval: evalSpy })
    expect(await checkRateLimit('ns', 'k', 5, 60_000)).toBe(true)
    expect(evalSpy).toHaveBeenCalledTimes(1)
    const args = evalSpy.mock.calls[0] as unknown[]
    expect(args[1]).toBe(1)
    expect(args[2]).toBe('rl:ns:k')
    expect(args[5]).toBe(5)
  })
})

describe('consumeRateLimitBudget (fails OPEN)', () => {
  it('returns allowed=true with full remaining when Valkey throws', async () => {
    mockValkey({ eval: asyncThrow('boom') })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(1000)
  })

  it('Sentry-captures the Valkey error', async () => {
    mockValkey({ eval: asyncThrow('boom') })
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
    mockValkey({ eval: async () => [0, 950] })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(50)
  })

  it('reports the post-debit remaining on a normal allowed call', async () => {
    mockValkey({ eval: async () => [1, 200] })
    const result = await consumeRateLimitBudget('test', 'key', 100, 1000, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(800)
  })
})

describe('tryAcquireSessionLock (fails CLOSED)', () => {
  it('returns false when Valkey throws, fail-closed: do not proceed without the lock', async () => {
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

  it('does NOT honour TEST_MODE bypass, must always exercise the real Valkey path', async () => {
    process.env.TEST_MODE = '1'
    // simulate lock already held; even with TEST_MODE the function
    // must still call SET NX EX and surface the null response.
    mockValkey({ set: async () => null })
    expect(await tryAcquireSessionLock('dictate', 'user-42', 60_000)).toBe(false)
  })
})

describe('releaseSessionLock (best-effort)', () => {
  it('swallows Valkey errors silently, TTL is the safety net', async () => {
    mockValkey({ del: asyncThrow('boom') })
    await expect(releaseSessionLock('dictate', 'user-42')).resolves.toBeUndefined()
  })

  it('does NOT honour TEST_MODE bypass, must call DEL even under TEST_MODE so lock truly clears in tests', async () => {
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
  it('returns allowed=false on Valkey error, failing open would re-open the cap race', async () => {
    mockValkey({ eval: asyncThrow('boom') })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.current).toBe(0)
  })

  it('Sentry-captures the Valkey error', async () => {
    mockValkey({ eval: asyncThrow('boom') })
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
    mockValkey({ eval: async () => [0, 5] })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.current).toBe(5)
  })

  it('returns the post-increment counter on success', async () => {
    mockValkey({ eval: async () => [1, 3] })
    const result = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.current).toBe(3)
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

describe('TEST_MODE bypass: honoured by fail-OPEN helpers, NOT by lock helpers', () => {
  it('checkRateLimit returns true under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const evalSpy = vi.fn()
    mockValkey({ eval: evalSpy })
    expect(await checkRateLimit('any', 'any', 1, 1)).toBe(true)
    expect(evalSpy).not.toHaveBeenCalled()
  })

  it('consumeRateLimitBudget returns allowed=true with maxCost remaining without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const evalSpy = vi.fn()
    mockValkey({ eval: evalSpy })
    const r = await consumeRateLimitBudget('any', 'any', 50, 500, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(500)
    expect(evalSpy).not.toHaveBeenCalled()
  })

  it('reserveInflightSlot returns allowed=true under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const evalSpy = vi.fn()
    mockValkey({ eval: evalSpy })
    const r = await reserveInflightSlot('upload', 'ws-1', 5, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.current).toBe(0)
    expect(evalSpy).not.toHaveBeenCalled()
  })

  it('the TEST_MODE bypass is ignored on an instance that looks like a real deployment', async () => {
    process.env.TEST_MODE = '1'
    const original = process.env.NUXT_SITE_URL
    process.env.NUXT_SITE_URL = 'https://docs.example.org'
    try {
      const evalSpy = vi.fn(async () => 0)
      mockValkey({ eval: evalSpy })
      expect(await checkRateLimit('any', 'any', 1, 1)).toBe(false)
      expect(evalSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (original === undefined) delete process.env.NUXT_SITE_URL
      else process.env.NUXT_SITE_URL = original
    }
  })

  it('releaseInflightSlot returns under TEST_MODE without touching Valkey', async () => {
    process.env.TEST_MODE = '1'
    const decr = vi.fn()
    mockValkey({ decr })
    await expect(releaseInflightSlot('upload', 'ws-1')).resolves.toBeUndefined()
    expect(decr).not.toHaveBeenCalled()
  })
})
