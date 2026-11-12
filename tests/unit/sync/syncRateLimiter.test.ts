import { describe, it, expect } from 'vitest'
import { captureLogs } from '../../helpers/logs'
import { createRateLimiter } from '../../../sync-server/src/rate-limiter'
import { deliberatelyInvalid } from '../../helpers/fixtures'

const logs = captureLogs()

// Hocuspocus connection rate limiter. Two independent caps:
//   - per-IP: fairness / small-scale abuse.
//   - active rooms: memory ceiling / large-scale crawl.
//
// Tests build fresh limiters via createRateLimiter() so each case is
// isolated — the production singleton's internal Maps would otherwise
// leak state between cases.

// Builder for the hook-data shape Hocuspocus passes in. Only the fields
// the limiter reads matter; everything else is stubbed with defaults that
// keep the limiter on its intended paths.
function hookData(opts: {
  ip?: string
  xffArray?: boolean
  socketId?: string
  roomCount?: number
  missingXff?: boolean
} = {}): Record<string, unknown> {
  const headers: Record<string, unknown> = {}
  if (!opts.missingXff) {
    const ip = opts.ip ?? '1.2.3.4'
    headers['x-forwarded-for'] = opts.xffArray ? [ip] : ip
  }
  return {
    request: { headers },
    socketId: opts.socketId ?? `sock-${Math.random()}`,
    instance: typeof opts.roomCount === 'number'
      ? { documents: { size: opts.roomCount } }
      : undefined
  }
}

describe('createRateLimiter — per-IP cap', () => {
  it('allows up to the per-IP maximum', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 3 })
    for (let i = 0; i < 3; i++) {
      expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: `s${i}` }))).not.toThrow()
    }
  })

  it('rejects the (max+1)th connection from the same IP', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 3 })
    for (let i = 0; i < 3; i++) {
      rl.onConnect(hookData({ ip: '1.1.1.1', socketId: `s${i}` }))
    }
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 's4' })))
      .toThrow('Too many connections')
  })

  it('separate IPs do not share the bucket', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'a1' }))
    rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'a2' }))
    // IP-A at cap; IP-B should be unaffected.
    expect(() => rl.onConnect(hookData({ ip: '2.2.2.2', socketId: 'b1' }))).not.toThrow()
    expect(() => rl.onConnect(hookData({ ip: '2.2.2.2', socketId: 'b2' }))).not.toThrow()
  })

  it('disconnect decrements so the slot reopens', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    const d1 = hookData({ ip: '1.1.1.1', socketId: 'a1' })
    const d2 = hookData({ ip: '1.1.1.1', socketId: 'a2' })
    rl.onConnect(d1)
    rl.onConnect(d2)
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'a3' })))
      .toThrow('Too many connections')
    rl.onDisconnect(d1)
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'a3' }))).not.toThrow()
  })

  it('disconnect for an unknown socketId is a silent no-op (underflow guard)', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    // Never connected — disconnecting must not crash or go negative.
    expect(() => rl.onDisconnect(hookData({ socketId: 'nope' }))).not.toThrow()
    // And the IP is still clean for fresh connections.
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 's1' }))).not.toThrow()
  })

  it('full connect/disconnect cycle leaves the internal Maps clean', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 3 })
    const datas = [0, 1, 2].map(i => hookData({ ip: '1.1.1.1', socketId: `s${i}` }))
    for (const d of datas) rl.onConnect(d)
    for (const d of datas) rl.onDisconnect(d)
    const snap = rl._snapshot()
    expect(snap.connectionsPerIP.size).toBe(0)
    expect(snap.connectionIPs.size).toBe(0)
  })
})

describe('createRateLimiter — IP extraction', () => {
  it('keys on the entry appended by the trusted proxy (rightmost), not the client-supplied first entry', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    // A client sent "1.1.1.1, 2.2.2.2"; Traefik (1 trusted hop) appended
    // the real peer 3.3.3.3. Only 3.3.3.3 is trustworthy.
    rl.onConnect(hookData({ ip: '1.1.1.1, 2.2.2.2, 3.3.3.3', socketId: 's1' }))
    expect(() => rl.onConnect(hookData({ ip: '3.3.3.3', socketId: 's2' })))
      .toThrow('Too many connections')
  })

  it('a spoofed first entry cannot escape the per-IP bucket', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    rl.onConnect(hookData({ ip: '9.9.9.1, 3.3.3.3', socketId: 's1' }))
    expect(() => rl.onConnect(hookData({ ip: '9.9.9.2, 3.3.3.3', socketId: 's2' })))
      .toThrow('Too many connections')
  })

  it('honours a larger trusted-hop count (own proxy in front of Traefik)', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1, trustedHops: 2 })
    rl.onConnect(hookData({ ip: '6.6.6.6, 1.1.1.1, 10.0.0.2', socketId: 's1' }))
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1, 10.0.0.2', socketId: 's2' })))
      .toThrow('Too many connections')
  })

  it('trims whitespace around entries', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    rl.onConnect(hookData({ ip: '2.2.2.2 ,  1.1.1.1  ', socketId: 's1' }))
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 's2' })))
      .toThrow('Too many connections')
  })

  it('accepts array-valued XFF header (nodejs sometimes shapes it that way)', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    rl.onConnect(hookData({ ip: '1.1.1.1', xffArray: true, socketId: 's1' }))
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 's2' })))
      .toThrow('Too many connections')
  })

  it('missing XFF falls back to the socket address', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    const direct = (socketId: string) => ({
      request: { headers: {}, socket: { remoteAddress: '::ffff:192.0.2.7' } },
      socketId
    })
    rl.onConnect(direct('a'))
    expect(() => rl.onConnect(direct('b'))).toThrow('Too many connections')
    // Another peer is a different bucket.
    expect(() => rl.onConnect(hookData({ ip: '192.0.2.8', socketId: 'c' }))).not.toThrow()
  })

  it('missing XFF and socket address buckets into the shared "unknown" slot', () => {
    // Not a great place to be — in prod, Traefik always sets XFF and this
    // path is cold. Pin the behaviour so a change to "fail-closed on
    // missing XFF" is an explicit decision.
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    rl.onConnect(hookData({ missingXff: true, socketId: 'a' }))
    rl.onConnect(hookData({ missingXff: true, socketId: 'b' }))
    expect(() => rl.onConnect(hookData({ missingXff: true, socketId: 'c' })))
      .toThrow('Too many connections')
  })
})

describe('createRateLimiter — room cap', () => {
  it('allows connections while rooms are below the cap', () => {
    const rl = createRateLimiter({ maxActiveRooms: 100 })
    expect(() => rl.onConnect(hookData({ roomCount: 50 }))).not.toThrow()
    expect(() => rl.onConnect(hookData({ roomCount: 99 }))).not.toThrow()
  })

  it('rejects the connection that would exceed the room cap', () => {
    const rl = createRateLimiter({ maxActiveRooms: 100 })
    expect(() => rl.onConnect(hookData({ roomCount: 100 })))
      .toThrow('Server at capacity')
  })

  it('room cap is checked before the per-IP cap', () => {
    // If both caps would trip simultaneously, room cap wins — its message
    // is a global-state signal that clients should interpret as "the
    // whole service is backed up", not "your IP specifically is throttled".
    const rl = createRateLimiter({
      maxConnectionsPerIP: 1,
      maxActiveRooms: 2
    })
    rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'a', roomCount: 0 }))
    // Next connect would trip BOTH caps (same IP + rooms at 2).
    expect(() => rl.onConnect(hookData({ ip: '1.1.1.1', socketId: 'b', roomCount: 2 })))
      .toThrow('Server at capacity')
  })

  it('missing instance.documents.size is treated as no-cap', () => {
    // Hocuspocus hook shape drift — if the counter isn't accessible, fail
    // open rather than refuse every connection. The per-IP cap still
    // applies.
    const rl = createRateLimiter({ maxActiveRooms: 10 })
    expect(() => rl.onConnect(deliberatelyInvalid({ request: { headers: { 'x-forwarded-for': '1.1.1.1' } }, socketId: 's1' })))
      .not.toThrow()
  })
})

describe('createRateLimiter — resilience', () => {
  it('does not throw on malformed hook data (fails open)', () => {
    // Regression guard for the existing try/catch. A wedged limiter
    // shouldn't DoS legitimate traffic — defensive behaviour is documented
    // in the module comment.
    const rl = createRateLimiter({ maxConnectionsPerIP: 20 })
    expect(() => rl.onConnect(deliberatelyInvalid({}))).not.toThrow()
    expect(() => rl.onConnect(deliberatelyInvalid({ request: null }))).not.toThrow()
    expect(() => rl.onDisconnect(deliberatelyInvalid({}))).not.toThrow()
  })

  it('the default singleton exists and is usable', async () => {
    // Smoke: the module-level export is the production instance.
    const { rateLimiter } = await import('../../../sync-server/src/rate-limiter')
    expect(typeof rateLimiter.onConnect).toBe('function')
    expect(typeof rateLimiter.onDisconnect).toBe('function')
  })

  it('each createRateLimiter() call has isolated state', () => {
    const rl1 = createRateLimiter({ maxConnectionsPerIP: 1 })
    const rl2 = createRateLimiter({ maxConnectionsPerIP: 1 })
    rl1.onConnect(hookData({ ip: '1.1.1.1', socketId: 'x' }))
    // rl2 should have a clean slate.
    expect(() => rl2.onConnect(hookData({ ip: '1.1.1.1', socketId: 'y' }))).not.toThrow()
  })

  it('logs (but does not throw) on unexpected errors inside the bookkeeping block', () => {
    // When onConnect's internal bookkeeping throws on a non-cap error, we
    // fail open, and log it.
    const rl = createRateLimiter({ maxConnectionsPerIP: 5 })
    const broken = {
      get request() { throw new Error('boom') }
    }
    expect(() => rl.onConnect(broken as never)).not.toThrow()
    expect(logs.find('warn', 'onConnect error')).toMatchObject({ component: 'rate-limiter' })
  })
})

// Hocuspocus runs `onConnect` (which takes the slot) BEFORE
// `onAuthenticate`, but only wires `onDisconnect` for connections that
// authenticated. A socket whose handshake is rejected therefore never
// fires `onDisconnect`; its slot must be released when the raw socket
// closes, or ~20 bad handshakes lock the IP out until a restart.
describe('createRateLimiter — socket teardown releases slots', () => {
  function socketPair(ip: string, socketId: string, documentName = 'doc-1') {
    const request = { headers: { 'x-forwarded-for': ip } }
    return { request, socketId, documentName }
  }

  it('releases the slot of a socket whose authentication failed when the socket closes', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    const a = socketPair('7.7.7.7', 'fail-a')
    const b = socketPair('7.7.7.7', 'fail-b')
    rl.onConnect(a)
    rl.onConnect(b)
    // Auth failed → no onDisconnect. Only the raw socket close arrives.
    rl.onSocketClosed(a.request)
    rl.onSocketClosed(b.request)
    expect(rl._snapshot().connectionsPerIP.size).toBe(0)
    expect(() => rl.onConnect(socketPair('7.7.7.7', 'legit'))).not.toThrow()
  })

  it('a flood of failed handshakes larger than the cap does not lock the IP out', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 3 })
    for (let i = 0; i < 25; i++) {
      const s = socketPair('8.8.8.8', `flood-${i}`)
      rl.onConnect(s)
      rl.onSocketClosed(s.request)
    }
    expect(() => rl.onConnect(socketPair('8.8.8.8', 'after-flood'))).not.toThrow()
  })

  it('onDisconnect then socket close does not double-decrement', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    const a = socketPair('9.9.9.9', 'a')
    const b = socketPair('9.9.9.9', 'b')
    rl.onConnect(a)
    rl.onConnect(b)
    rl.onDisconnect(a)
    rl.onSocketClosed(a.request)
    expect(rl._snapshot().connectionsPerIP.get('9.9.9.9')).toBe(1)
  })

  it('one socket multiplexing two documents releases both slots on close', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 2 })
    const request = { headers: { 'x-forwarded-for': '5.5.5.5' } }
    rl.onConnect({ request, socketId: 'mux', documentName: 'doc-a' })
    rl.onConnect({ request, socketId: 'mux', documentName: 'doc-b' })
    expect(rl._snapshot().connectionsPerIP.get('5.5.5.5')).toBe(2)
    rl.onSocketClosed(request)
    expect(rl._snapshot().connectionsPerIP.size).toBe(0)
  })

  it('an auth frame processed after the socket already closed takes no slot', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    const a = socketPair('4.4.4.4', 'late')
    rl.onSocketClosed(a.request)
    rl.onConnect(a)
    expect(rl._snapshot().connectionsPerIP.size).toBe(0)
  })

  it('trackSocket releases on the socket close event', () => {
    const rl = createRateLimiter({ maxConnectionsPerIP: 1 })
    const listeners: Array<() => void> = []
    const socket = {
      once: (_event: 'close', fn: () => void) => {
        listeners.push(fn)
      }
    }
    const a = socketPair('3.3.3.3', 'tracked')
    rl.trackSocket(socket, a.request)
    rl.onConnect(a)
    for (const fn of listeners) fn()
    expect(() => rl.onConnect(socketPair('3.3.3.3', 'next'))).not.toThrow()
  })
})
