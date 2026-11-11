import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkRateLimit,
  consumeRateLimitBudget,
  isRateLimitExhausted,
  recordRateLimitEvent,
  reserveInflightSlot
} from '../../server/utils/platform/rateLimit'
import { DOC_PASSWORD_LIMITS, admitPasswordAttempt, recordPasswordFailure } from '../../server/utils/documents/docPasswordLimits'
import {
  claimPendingKnowledgeUpload,
  recordPendingKnowledgeUpload,
  restorePendingKnowledgeUpload
} from '../../server/utils/knowledge/knowledgePendingUpload'

// Limiter semantics against the REAL Valkey test container (the unit
// tests only pin fail-mode polarity with a mocked client). The headline
// property: a concurrent burst can't get past a limit. Before the
// check-and-record became one Lua script, 200 parallel calls with a
// limit of 5 were ALL admitted, because every call read the count before
// any of them wrote.
//
// The repos tier runs with TEST_MODE=1 (testEnv.ts), which bypasses the
// limiters — switched off for this file. Every test uses a fresh random
// namespace / key, so no cleanup between cases is needed (keys TTL out).

let savedTestMode: string | undefined

beforeAll(() => {
  savedTestMode = process.env.TEST_MODE
  delete process.env.TEST_MODE
})

afterAll(() => {
  if (savedTestMode === undefined) delete process.env.TEST_MODE
  else process.env.TEST_MODE = savedTestMode
})

function unique(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`
}

async function burst<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, () => fn()))
}

describe('checkRateLimit (real Valkey)', () => {
  it('admits exactly maxAttempts out of a 200-request concurrent burst', async () => {
    const ns = unique('burst')
    const results = await burst(200, () => checkRateLimit(ns, 'client', 5, 60_000))
    expect(results.filter(Boolean)).toHaveLength(5)
  })

  it('sequential: allows up to the limit, then refuses', async () => {
    const ns = unique('seq')
    for (let i = 0; i < 3; i++) expect(await checkRateLimit(ns, 'k', 3, 60_000)).toBe(true)
    expect(await checkRateLimit(ns, 'k', 3, 60_000)).toBe(false)
    // Another key in the same namespace has its own bucket.
    expect(await checkRateLimit(ns, 'other', 3, 60_000)).toBe(true)
  })

  it('slides: attempts older than the window stop counting', async () => {
    const ns = unique('slide')
    expect(await checkRateLimit(ns, 'k', 1, 300)).toBe(true)
    expect(await checkRateLimit(ns, 'k', 1, 300)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await checkRateLimit(ns, 'k', 1, 300)).toBe(true)
  })
})

describe('isRateLimitExhausted / recordRateLimitEvent (real Valkey)', () => {
  it('counts only recorded events and never records on a check', async () => {
    const ns = unique('events')
    expect(await isRateLimitExhausted(ns, 'k', 2, 60_000)).toBe(false)
    await recordRateLimitEvent(ns, 'k', 60_000)
    expect(await isRateLimitExhausted(ns, 'k', 2, 60_000)).toBe(false)
    await recordRateLimitEvent(ns, 'k', 60_000)
    expect(await isRateLimitExhausted(ns, 'k', 2, 60_000)).toBe(true)
  })
})

describe('consumeRateLimitBudget (real Valkey)', () => {
  it('debits under the cap and refuses (without debiting) over it', async () => {
    const ns = unique('budget')
    expect(await consumeRateLimitBudget(ns, 'u', 900, 1000, 60_000)).toEqual({ allowed: true, remaining: 100 })
    expect(await consumeRateLimitBudget(ns, 'u', 200, 1000, 60_000)).toEqual({ allowed: false, remaining: 100 })
    // cost 0 = peek, no debit.
    expect(await consumeRateLimitBudget(ns, 'u', 0, 1000, 60_000)).toEqual({ allowed: true, remaining: 100 })
    expect(await consumeRateLimitBudget(ns, 'u', 100, 1000, 60_000)).toEqual({ allowed: true, remaining: 0 })
  })

  it('isolates buckets by namespace and key', async () => {
    const ns = unique('budget-iso')
    await consumeRateLimitBudget(ns, 'u1', 900, 1000, 60_000)
    expect((await consumeRateLimitBudget(ns, 'u2', 900, 1000, 60_000)).allowed).toBe(true)
    expect((await consumeRateLimitBudget(unique('budget-other'), 'u1', 900, 1000, 60_000)).allowed).toBe(true)
  })

  it('a concurrent burst cannot jointly overshoot the cap', async () => {
    const ns = unique('budget-burst')
    const results = await burst(50, () => consumeRateLimitBudget(ns, 'u', 100, 1000, 60_000))
    expect(results.filter(r => r.allowed)).toHaveLength(10)
  })
})

describe('reserveInflightSlot (real Valkey)', () => {
  it('a concurrent burst reserves exactly maxSlots', async () => {
    const ns = unique('inflight')
    const results = await burst(50, () => reserveInflightSlot(ns, 'ws', 5, 60_000))
    expect(results.filter(r => r.allowed)).toHaveLength(5)
  })
})

describe('document password verify limits (real Valkey)', () => {
  it('per client + doc: a concurrent burst gets exactly the per-client allowance', async () => {
    const docId = unique('doc')
    const results = await burst(100, () => admitPasswordAttempt('203.0.113.9', docId))
    expect(results.filter(r => r === 'allowed')).toHaveLength(DOC_PASSWORD_LIMITS.perClient.max)
  })

  it('per doc: many clients together are capped by the per-doc limit', async () => {
    const docId = unique('doc')
    const clients = Array.from({ length: 20 }, (_, i) => `2001:db8:${i}:0::/64`)
    const results = await Promise.all(
      clients.flatMap(client => Array.from({ length: 5 }, () => admitPasswordAttempt(client, docId)))
    )
    expect(results.filter(r => r === 'allowed')).toHaveLength(DOC_PASSWORD_LIMITS.perDoc.max)
  })

  it('failure budget: enough failed attempts lock the doc for every client', async () => {
    const docId = unique('doc')
    for (let i = 0; i < DOC_PASSWORD_LIMITS.failures.max; i++) await recordPasswordFailure(docId)
    expect(await admitPasswordAttempt('198.51.100.1', docId)).toBe('locked')
    expect(await admitPasswordAttempt('198.51.100.2', docId)).toBe('locked')
    // Other docs are unaffected.
    expect(await admitPasswordAttempt('198.51.100.1', unique('doc'))).toBe('allowed')
  })
})

describe('pending knowledge uploads (real Valkey)', () => {
  const pending = { s3Key: 'workspaces/ws/knowledge/k1.pdf', ext: 'pdf', mimeType: 'application/pdf' }

  it('can only be claimed once, by the user + workspace it was issued to', async () => {
    const knowledgeId = unique('k')
    const ref = { workspaceId: 'ws-a', userId: 1, knowledgeId }
    await recordPendingKnowledgeUpload(ref, pending)

    expect(await claimPendingKnowledgeUpload({ ...ref, userId: 2 })).toBeNull()
    expect(await claimPendingKnowledgeUpload({ ...ref, workspaceId: 'ws-b' })).toBeNull()
    expect(await claimPendingKnowledgeUpload(ref)).toEqual(pending)
    expect(await claimPendingKnowledgeUpload(ref)).toBeNull()
  })

  it('a concurrent double confirm claims it exactly once', async () => {
    const ref = { workspaceId: 'ws-a', userId: 1, knowledgeId: unique('k') }
    await recordPendingKnowledgeUpload(ref, pending)
    const claims = await burst(10, () => claimPendingKnowledgeUpload(ref))
    expect(claims.filter(c => c !== null)).toHaveLength(1)
  })

  it('restore puts a claimed record back for a retry', async () => {
    const ref = { workspaceId: 'ws-a', userId: 1, knowledgeId: unique('k') }
    await recordPendingKnowledgeUpload(ref, pending)
    const claimed = await claimPendingKnowledgeUpload(ref)
    expect(claimed).toEqual(pending)
    if (claimed) await restorePendingKnowledgeUpload(ref, claimed)
    expect(await claimPendingKnowledgeUpload(ref)).toEqual(pending)
  })
})
