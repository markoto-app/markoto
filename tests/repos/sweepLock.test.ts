import { describe, it, expect, afterEach } from 'vitest'
import { acquireSweepLock, releaseSweepLock } from '../../server/utils/platform/sweepLock'

// Postgres advisory locks are session-scoped — bound to the connection
// that called `pg_try_advisory_lock`. Both calls in a test go through
// the same Node process but each `acquireSweepLock` call picks up a
// FRESH `PoolClient` from the shared pool, so the second acquire-call
// on the same lock name sees the lock held by the FIRST connection and
// returns false. That mirrors the multi-instance scenario one Node
// process at a time.

const NAMES_TO_RELEASE: string[] = []

afterEach(async () => {
  // Best-effort cleanup so a failing test doesn't leak the lock into
  // subsequent test files. Idempotent: no-op if not held here.
  while (NAMES_TO_RELEASE.length > 0) {
    const n = NAMES_TO_RELEASE.pop()!
    await releaseSweepLock(n)
  }
})

describe('sweepLock', () => {
  it('first acquire wins, second on same name returns false', async () => {
    const name = 'sweeplock-test-a'
    const ok1 = await acquireSweepLock(name)
    NAMES_TO_RELEASE.push(name)
    expect(ok1).toBe(true)

    const ok2 = await acquireSweepLock(name)
    expect(ok2).toBe(false)
  })

  it('release lets the next acquire on the same name succeed', async () => {
    const name = 'sweeplock-test-b'
    const ok1 = await acquireSweepLock(name)
    expect(ok1).toBe(true)
    await releaseSweepLock(name)

    const ok2 = await acquireSweepLock(name)
    NAMES_TO_RELEASE.push(name)
    expect(ok2).toBe(true)
  })

  it('different lock names do not collide', async () => {
    const a = 'sweeplock-test-c1'
    const b = 'sweeplock-test-c2'
    const okA = await acquireSweepLock(a)
    NAMES_TO_RELEASE.push(a)
    const okB = await acquireSweepLock(b)
    NAMES_TO_RELEASE.push(b)
    expect(okA).toBe(true)
    expect(okB).toBe(true)
  })

  it('release without a prior acquire is a silent no-op', async () => {
    // Should not throw and should not affect a subsequent acquire.
    await releaseSweepLock('sweeplock-test-never-acquired')
    const ok = await acquireSweepLock('sweeplock-test-never-acquired')
    NAMES_TO_RELEASE.push('sweeplock-test-never-acquired')
    expect(ok).toBe(true)
  })

  it('double-release is a silent no-op', async () => {
    const name = 'sweeplock-test-d'
    const ok = await acquireSweepLock(name)
    expect(ok).toBe(true)
    await releaseSweepLock(name)
    await releaseSweepLock(name) // idempotent
    // Re-acquire still works.
    const ok2 = await acquireSweepLock(name)
    NAMES_TO_RELEASE.push(name)
    expect(ok2).toBe(true)
  })
})
