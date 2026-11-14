import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SpeechStream } from '../../../server/utils/agentic/dictateSpeechClient'
import { DictatePeerContext, SESSION_HARD_CAP_MS, type PeerLike } from '../../../server/utils/agentic/dictation/peerContext'
import {
  END_FLUSH_DEADLINE_MS,
  armHardCap,
  beginSessionEnd,
  completeSession,
  resetIdleTimer
} from '../../../server/utils/agentic/dictation/sessionEnd'

// How the relay ends a dictation session: no more audio, the upstream
// flushes, then `done`, then the close. The client keeps its interim text
// until `done`, so the order of frames is the contract.

vi.mock('../../../server/utils/agentic/dictation/voiceTicks', () => ({
  stopVoiceTickOrchestrator: vi.fn()
}))

const { stopVoiceTickOrchestrator } = await import('../../../server/utils/agentic/dictation/voiceTicks')

class FakeStream extends EventEmitter implements SpeechStream {
  end = vi.fn()
  write = vi.fn(() => true)
  destroy = vi.fn()
}

function fakePeer() {
  const sent: Array<{ type: string }> = []
  const closes: Array<{ code?: number, reason?: string }> = []
  const peer: PeerLike = {
    send: (data: string) => sent.push(JSON.parse(data)),
    close: (code, reason) => closes.push({ code, reason }),
    context: {}
  }
  return { peer, sent, closes, types: () => sent.map(f => f.type) }
}

function session() {
  const p = fakePeer()
  const ctx = new DictatePeerContext()
  const stt = new FakeStream()
  ctx.stt = stt
  // What `upstreamSession.ts` wires: the upstream's end completes the session.
  stt.on('end', () => completeSession(p.peer, ctx))
  return { ...p, ctx, stt }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(stopVoiceTickOrchestrator).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('beginSessionEnd (client stop)', () => {
  it('ends the upstream input, stops billing at once and keeps the socket open', () => {
    const s = session()
    beginSessionEnd(s.peer, s.ctx)

    expect(s.stt.end).toHaveBeenCalledOnce()
    expect(s.ctx.sttEnded).toBe(true)
    expect(stopVoiceTickOrchestrator).toHaveBeenCalledOnce()
    expect(s.sent).toEqual([])
    expect(s.closes).toEqual([])
  })

  it('sends done and closes 1000 once the upstream has ended', () => {
    const s = session()
    beginSessionEnd(s.peer, s.ctx)
    vi.advanceTimersByTime(700)
    s.stt.emit('end')

    expect(s.types()).toEqual(['done'])
    expect(s.closes).toEqual([{ code: 1000, reason: 'stt ended' }])
  })

  it('sends done and closes after the deadline when the upstream never answers', () => {
    const s = session()
    beginSessionEnd(s.peer, s.ctx)
    vi.advanceTimersByTime(END_FLUSH_DEADLINE_MS - 1)
    expect(s.closes).toEqual([])
    vi.advanceTimersByTime(1)

    expect(s.types()).toEqual(['done'])
    expect(s.closes).toHaveLength(1)

    // A late upstream end does not close a second time.
    s.stt.emit('end')
    expect(s.types()).toEqual(['done'])
    expect(s.closes).toHaveLength(1)
  })

  it('a second stop changes nothing', () => {
    const s = session()
    beginSessionEnd(s.peer, s.ctx)
    beginSessionEnd(s.peer, s.ctx, { code: 4003, reason: 'session cap' })
    s.stt.emit('end')

    expect(s.stt.end).toHaveBeenCalledOnce()
    expect(s.closes).toEqual([{ code: 1000, reason: 'stt ended' }])
  })

  it('does not fire the idle timeout or the session cap while it waits', () => {
    const s = session()
    resetIdleTimer(s.peer, s.ctx)
    armHardCap(s.peer, s.ctx)
    beginSessionEnd(s.peer, s.ctx)
    s.stt.emit('end')
    vi.advanceTimersByTime(SESSION_HARD_CAP_MS)

    expect(s.types()).toEqual(['done'])
  })

  it('says nothing to a socket that is already closed', () => {
    const s = session()
    beginSessionEnd(s.peer, s.ctx)
    s.ctx.closed = true
    s.stt.emit('end')
    vi.advanceTimersByTime(END_FLUSH_DEADLINE_MS)

    expect(s.sent).toEqual([])
    expect(s.closes).toEqual([])
  })
})

describe('sessions the server ends', () => {
  it('idle timeout: announces it, flushes the upstream, then done and close 4001', () => {
    const s = session()
    resetIdleTimer(s.peer, s.ctx)
    vi.advanceTimersByTime(30_000)

    expect(s.types()).toEqual(['idle-timeout'])
    expect(s.stt.end).toHaveBeenCalledOnce()
    expect(s.closes).toEqual([])

    s.stt.emit('end')
    expect(s.types()).toEqual(['idle-timeout', 'done'])
    expect(s.closes).toEqual([{ code: 4001, reason: 'idle timeout' }])
  })

  it('session cap: announces it, flushes the upstream, then done and close 4003', () => {
    const s = session()
    armHardCap(s.peer, s.ctx)
    vi.advanceTimersByTime(SESSION_HARD_CAP_MS)

    expect(s.types()).toEqual(['session-cap'])
    expect(stopVoiceTickOrchestrator).toHaveBeenCalledOnce()

    s.stt.emit('end')
    expect(s.types()).toEqual(['session-cap', 'done'])
    expect(s.closes).toEqual([{ code: 4003, reason: 'session cap' }])
  })
})
