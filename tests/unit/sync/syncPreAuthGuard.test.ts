import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import * as encoding from 'lib0/encoding'
import {
  createPreAuthGuard,
  parsePreAuthLimits,
  PREAUTH_MESSAGE_OVERHEAD_BYTES,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_MAX_PREAUTH_BYTES,
  DEFAULT_MAX_PREAUTH_TOTAL_BYTES,
  type PreAuthLimits
} from '../../../sync-server/src/pre-auth-guard'
import { SYNC_CLOSE_CODES } from '../../../shared/contracts/syncClose'
import { syncEnvFrom } from '../../../sync-server/src/env'

const preAuthLimitsFrom = (raw: Record<string, string | undefined>) => parsePreAuthLimits(syncEnvFrom(raw))

// Hocuspocus queues every message a socket sends for a document until that
// document has authenticated. The pre-auth guard bounds what such a queue
// may hold (per socket + process-wide) and how long a document may queue
// without sending its Auth frame.

class FakeSocket extends EventEmitter {
  closes: Array<{ code: number, reason: string }> = []
  terminated = false
  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
  }

  terminate(): void {
    this.terminated = true
    this.emit('close')
  }
}

function frame(doc: string, type: number, payloadBytes = 0): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, doc)
  encoding.writeVarUint(enc, type)
  encoding.writeVarUint8Array(enc, new Uint8Array(payloadBytes))
  return encoding.toUint8Array(enc)
}
const AUTH = 2
const SYNC = 0
const AWARENESS = 1

const LIMITS: PreAuthLimits = { maxBytesPerSocket: 10_000, maxBytesTotal: 25_000, authTimeoutMs: 1000 }

function setup(limits: PreAuthLimits = LIMITS) {
  const rejections: string[] = []
  const guard = createPreAuthGuard(limits, { onReject: reason => rejections.push(reason) })
  function open() {
    const socket = new FakeSocket()
    const request = {}
    guard.trackSocket(socket, request)
    const send = (data: Uint8Array) => socket.emit('message', data)
    return { socket, request, send }
  }
  return { guard, rejections, open }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pre-auth guard — bytes', () => {
  it('closes a socket whose unauthenticated queue exceeds the per-socket cap', () => {
    const { open, rejections } = setup()
    const c = open()
    for (let i = 0; i < 4; i++) c.send(frame('doc', SYNC, 2000))
    expect(c.socket.closes).toEqual([])
    c.send(frame('doc', SYNC, 2000))
    expect(c.socket.closes).toEqual([{ code: SYNC_CLOSE_CODES.payloadTooLarge, reason: 'update-too-large' }])
    expect(rejections).toEqual(['too-large'])
  })

  it('charges a fixed overhead per frame, so floods of tiny frames are bounded too', () => {
    const { open } = setup()
    const c = open()
    const tiny = frame('doc', AWARENESS, 0)
    const perFrame = tiny.byteLength + PREAUTH_MESSAGE_OVERHEAD_BYTES
    const fits = Math.floor(LIMITS.maxBytesPerSocket / perFrame)
    for (let i = 0; i < fits; i++) c.send(frame('doc', AWARENESS, 0))
    expect(c.socket.closes).toEqual([])
    c.send(frame('doc', AWARENESS, 0))
    expect(c.socket.closes).toHaveLength(1)
  })

  it('also counts frames that arrive after a FAILED authentication (they stay queued)', () => {
    const { open } = setup()
    const c = open()
    c.send(frame('doc', AUTH, 10))
    for (let i = 0; i < 5; i++) c.send(frame('doc', SYNC, 2000))
    expect(c.socket.closes).toHaveLength(1)
  })

  it('enforces the process-wide cap across sockets', () => {
    const { open, guard } = setup()
    const sockets = [open(), open(), open()]
    for (const s of sockets.slice(0, 2)) {
      for (let i = 0; i < 4; i++) s.send(frame('doc', SYNC, 2000))
    }
    expect(guard._snapshot().totalBytes).toBeLessThan(LIMITS.maxBytesTotal)
    const third = sockets[2]
    if (!third) throw new Error('setup')
    for (let i = 0; i < 4; i++) third.send(frame('doc', SYNC, 2000))
    expect(third.socket.closes).toHaveLength(1)
  })

  it('stops counting a document once its connection is established, and frees its bytes', () => {
    const { open, guard } = setup()
    const c = open()
    const queued = [frame('doc', AUTH, 10), frame('doc', SYNC, 3000), frame('doc', AWARENESS, 100)]
    for (const f of queued) c.send(f)
    expect(guard._snapshot().totalBytes).toBeGreaterThan(3000)

    // Hocuspocus replays its queue (same objects) and then fires `connected`.
    for (const f of queued) c.send(f)
    guard.documentEstablished(c.request, 'socket-1', 'doc')
    expect(guard._snapshot().totalBytes).toBe(0)

    for (let i = 0; i < 20; i++) c.send(frame('doc', SYNC, 2000))
    expect(c.socket.closes).toEqual([])
  })

  it('counts a document again after its connection closed while the socket stays open', () => {
    const { open, guard } = setup()
    const c = open()
    c.send(frame('doc', AUTH, 10))
    guard.documentEstablished(c.request, 'socket-1', 'doc')
    guard.documentClosed('socket-1', 'doc')
    for (let i = 0; i < 5; i++) c.send(frame('doc', SYNC, 2000))
    expect(c.socket.closes).toHaveLength(1)
  })

  it('releases a closed socket\'s bytes', () => {
    const { open, guard } = setup()
    const c = open()
    c.send(frame('doc', SYNC, 3000))
    expect(guard._snapshot().totalBytes).toBeGreaterThan(0)
    c.socket.emit('close')
    expect(guard._snapshot().totalBytes).toBe(0)
  })

  it('terminates a rejected socket that does not finish the closing handshake', () => {
    const { open } = setup()
    const c = open()
    for (let i = 0; i < 6; i++) c.send(frame('doc', SYNC, 2000))
    expect(c.socket.terminated).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(c.socket.terminated).toBe(true)
  })
})

describe('pre-auth guard — auth timeout', () => {
  it('closes a socket whose document queued messages but never sent an Auth frame', () => {
    const { open, rejections } = setup()
    const c = open()
    c.send(frame('doc', SYNC, 10))
    vi.advanceTimersByTime(999)
    expect(c.socket.closes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(c.socket.closes).toEqual([{ code: SYNC_CLOSE_CODES.authTimeout, reason: 'auth-timeout' }])
    expect(rejections).toEqual(['auth-timeout'])
  })

  it('an Auth frame in time cancels the timeout (offline backlog flushed before the token)', () => {
    const { open } = setup()
    const c = open()
    c.send(frame('doc', SYNC, 10))
    c.send(frame('doc', SYNC, 10))
    vi.advanceTimersByTime(500)
    c.send(frame('doc', AUTH, 10))
    vi.advanceTimersByTime(5000)
    expect(c.socket.closes).toEqual([])
  })

  it('ignores frames it cannot decode (Hocuspocus closes those sockets itself)', () => {
    const { open, guard } = setup()
    const c = open()
    c.send(new Uint8Array([0xff]))
    c.socket.emit('message', 'text frame')
    vi.advanceTimersByTime(5000)
    expect(c.socket.closes).toEqual([])
    expect(guard._snapshot().totalBytes).toBe(0)
  })
})

describe('parsePreAuthLimits', () => {
  it('defaults', () => {
    expect(preAuthLimitsFrom({})).toEqual({
      maxBytesPerSocket: DEFAULT_MAX_PREAUTH_BYTES,
      maxBytesTotal: DEFAULT_MAX_PREAUTH_TOTAL_BYTES,
      authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS
    })
  })

  it('reads positive integers', () => {
    expect(preAuthLimitsFrom({ SYNC_MAX_PREAUTH_BYTES: '1000' }).maxBytesPerSocket).toBe(1000)
  })

  it('refuses junk instead of silently keeping the default', () => {
    expect(() => preAuthLimitsFrom({ SYNC_MAX_PREAUTH_TOTAL_BYTES: 'abc' })).toThrow(/SYNC_MAX_PREAUTH_TOTAL_BYTES: expected bytes/)
    expect(() => preAuthLimitsFrom({ SYNC_AUTH_TIMEOUT_MS: '-5' })).toThrow(/SYNC_AUTH_TIMEOUT_MS/)
  })
})
