import { describe, it, expect, vi } from 'vitest'
import {
  createConnectionExpiry,
  performReauthDocument,
  closeForReauth,
  isSyntheticPrincipal,
  type ExpiryClock,
  type ReauthConnection
} from '../../../sync-server/src/connection-expiry'
import type { VerifiedDocToken } from '../../../sync-server/src/auth'
import { SYNC_CLOSE_CODES, SYNC_REAUTH_REASON, isReauthClose, syncRejectionFromClose } from '../../../shared/contracts/syncClose'

// An open sync connection must not outlive its token: the server asks for
// a fresh one shortly before expiry, renews in place when it gets one,
// and closes with the re-authenticate reason when it doesn't.

const LEAD = 45_000
const GRACE = 5_000

/** Deterministic clock: timers fire only when `advance` passes them. */
function fakeClock(start = 1_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number, fn: () => void }>()
  const clock: ExpiryClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => {
      timers.delete(h as number)
    }
  }
  function advance(ms: number) {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = target
  }
  return { clock, advance, pending: () => timers.size, now: () => now }
}

function fakeConn(userId: string | number = 42, readOnly = false) {
  const conn = {
    context: { userId, tokenExpiresAt: 0 },
    readOnly,
    requestToken: vi.fn(),
    close: vi.fn(),
    webSocket: { close: vi.fn() }
  }
  return conn satisfies ReauthConnection
}

function verified(over: Partial<VerifiedDocToken> = {}): VerifiedDocToken {
  return { readOnly: false, userId: 42, userName: 'Alice', tokenExpiresAt: 0, ...over }
}

describe('connection expiry', () => {
  it('asks for a fresh token shortly before expiry and closes for re-auth at expiry + grace', () => {
    const { clock, advance, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    const exp = now() + 120_000
    expiry.track(conn, exp)

    advance(120_000 - LEAD - 1)
    expect(conn.requestToken).not.toHaveBeenCalled()
    advance(1)
    expect(conn.requestToken).toHaveBeenCalledOnce()
    expect(conn.close).not.toHaveBeenCalled()

    advance(LEAD + GRACE - 1)
    expect(conn.close).not.toHaveBeenCalled()
    advance(1)
    expect(conn.close).toHaveBeenCalledWith({ code: SYNC_CLOSE_CODES.reauthenticate, reason: SYNC_REAUTH_REASON })
    expect(conn.webSocket.close).toHaveBeenCalledWith(SYNC_CLOSE_CODES.reauthenticate, SYNC_REAUTH_REASON)
    expect(expiry.size()).toBe(0)
  })

  it('a renewed token keeps the connection open and moves the schedule', async () => {
    const { clock, advance, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    expiry.track(conn, now() + 120_000)
    advance(120_000 - LEAD)
    expect(conn.requestToken).toHaveBeenCalledOnce()

    const nextExp = now() + 2 * 3_600_000
    await expiry.renew(conn, 'fresh', 'doc-1', async () => verified({ tokenExpiresAt: nextExp }))
    expect(conn.context.tokenExpiresAt).toBe(nextExp)

    advance(LEAD + GRACE + 1)
    expect(conn.close).not.toHaveBeenCalled()
    advance(nextExp - LEAD - now())
    expect(conn.requestToken).toHaveBeenCalledTimes(2)
  })

  it('closes when the renewal token is refused (revoked, expired, other document)', async () => {
    const { clock, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    expiry.track(conn, now() + 3_600_000)
    await expiry.renew(conn, 'old', 'doc-1', async () => {
      throw new Error('Token revoked')
    })
    expect(conn.close).toHaveBeenCalledOnce()
    expect(expiry.size()).toBe(0)
  })

  it('closes when the renewal changes the principal or the write access', async () => {
    const { clock, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const exp = now() + 3_600_000
    const downgraded = fakeConn(42, false)
    expiry.track(downgraded, exp)
    await expiry.renew(downgraded, 't', 'doc-1', async () => verified({ readOnly: true, tokenExpiresAt: exp }))
    expect(downgraded.close).toHaveBeenCalledOnce()

    const other = fakeConn(42, false)
    expiry.track(other, exp)
    await expiry.renew(other, 't', 'doc-1', async () => verified({ userId: 'anonymous', tokenExpiresAt: exp }))
    expect(other.close).toHaveBeenCalledOnce()
  })

  it('asks a short-lived token only once instead of looping, then closes at its expiry', async () => {
    const { clock, advance, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    // A share link that ends in 20 s: the token can't live longer.
    const exp = now() + 20_000
    expiry.track(conn, exp)
    expect(conn.requestToken).toHaveBeenCalledOnce()
    await expiry.renew(conn, 't', 'doc-1', async () => verified({ tokenExpiresAt: exp }))
    expect(conn.requestToken).toHaveBeenCalledOnce()
    advance(20_000 + GRACE)
    expect(conn.close).toHaveBeenCalledOnce()
  })

  it('an already expired token closes right away', () => {
    const { clock, advance, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    expiry.track(conn, now() - 60_000)
    advance(0)
    expect(conn.close).toHaveBeenCalledOnce()
  })

  it('untrack clears the timer (no leak, no close after the socket is gone)', () => {
    const { clock, advance, pending, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    expiry.track(conn, now() + 120_000)
    expiry.untrack(conn)
    expect(pending()).toBe(0)
    expect(expiry.size()).toBe(0)
    advance(1_000_000)
    expect(conn.close).not.toHaveBeenCalled()
  })

  it('a renewal answer for a connection closed meanwhile does not restart its timer', async () => {
    const { clock, pending, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = fakeConn()
    expiry.track(conn, now() + 120_000)
    expiry.untrack(conn)
    await expiry.renew(conn, 't', 'doc-1', async () => verified({ tokenExpiresAt: now() + 3_600_000 }))
    expect(pending()).toBe(0)
  })

  it('renew never throws, also when closing fails', async () => {
    const { clock, now } = fakeClock()
    const expiry = createConnectionExpiry({ clock, renewLeadMs: LEAD, graceMs: GRACE })
    const conn = { ...fakeConn(), close: vi.fn(() => {
      throw new Error('gone')
    }) }
    expiry.track(conn, now() + 120_000)
    await expect(expiry.renew(conn, 't', 'doc-1', async () => {
      throw new Error('bad')
    })).resolves.toBeUndefined()
  })
})

describe('performReauthDocument', () => {
  it('closes every human and anonymous connection but leaves the app\'s own clients alone', () => {
    const alice = fakeConn(42)
    const anon = fakeConn('anonymous')
    const ai = fakeConn('ai:assistant:s1')
    const mcp = fakeConn('mcp:abc')
    const list = [alice, anon, ai, mcp]
    // Closing removes the connection from the live list (as Hocuspocus does).
    for (const c of list) c.close.mockImplementation(() => void list.splice(list.indexOf(c), 1))
    const closed = performReauthDocument({ getConnections: () => list })
    expect(closed).toBe(2)
    expect(alice.close).toHaveBeenCalledOnce()
    expect(anon.close).toHaveBeenCalledOnce()
    expect(ai.close).not.toHaveBeenCalled()
    expect(mcp.close).not.toHaveBeenCalled()
  })

  it('is a no-op for a document not loaded on this instance', () => {
    expect(performReauthDocument(undefined)).toBe(0)
  })

  it('closeForReauth reports a failing document close', () => {
    const conn = { ...fakeConn(), close: vi.fn(() => {
      throw new Error('gone')
    }) }
    expect(closeForReauth(conn)).toBe(false)
    expect(conn.webSocket.close).toHaveBeenCalledOnce()
  })

  it('recognises the synthetic principals only', () => {
    expect(isSyntheticPrincipal('restore:1:s')).toBe(true)
    expect(isSyntheticPrincipal('anonymous')).toBe(false)
    expect(isSyntheticPrincipal(42)).toBe(false)
  })
})

describe('re-authenticate close contract', () => {
  it('is recognised by the editor and is not a sync rejection (so it reconnects)', () => {
    expect(isReauthClose({ code: 1000, reason: SYNC_REAUTH_REASON })).toBe(true)
    expect(isReauthClose({ code: SYNC_CLOSE_CODES.reauthenticate, reason: SYNC_REAUTH_REASON })).toBe(true)
    expect(isReauthClose({ code: 1006, reason: '' })).toBe(false)
    expect(syncRejectionFromClose({ code: SYNC_CLOSE_CODES.reauthenticate, reason: SYNC_REAUTH_REASON })).toBeNull()
  })
})
