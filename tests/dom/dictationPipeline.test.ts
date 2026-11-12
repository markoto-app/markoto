import { describe, expect, it, vi, type Mock } from 'vitest'
import { dispatchDictationFrame, type DictationFrameHandlers } from '../../app/composables/ai/dictationPipeline'

// Live dictation's server frames reach `useVoiceDictation` through this
// dispatcher: one handler per frame type, malformed frames ignored.

type MockHandlers = { [K in keyof DictationFrameHandlers]: Mock<DictationFrameHandlers[K]> }

function handlers(): MockHandlers {
  return {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onBudgetExhausted: vi.fn(),
    onSessionCap: vi.fn(),
    onIdleTimeout: vi.fn(),
    onError: vi.fn()
  }
}

describe('dictation frame dispatch', () => {
  it('routes each frame type to its handler', () => {
    const h = handlers()
    dispatchDictationFrame(JSON.stringify({ type: 'ready' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'partial', text: 'hel' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'final', text: 'hello' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'budget-exhausted', remaining: 0 }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'session-cap' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'idle-timeout' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'error' }), h)
    expect(h.onReady).toHaveBeenCalledOnce()
    expect(h.onPartial).toHaveBeenCalledWith('hel')
    expect(h.onFinal).toHaveBeenCalledWith('hello')
    expect(h.onBudgetExhausted).toHaveBeenCalledWith(0)
    expect(h.onSessionCap).toHaveBeenCalledOnce()
    expect(h.onIdleTimeout).toHaveBeenCalledOnce()
    expect(h.onError).toHaveBeenCalledOnce()
  })

  it('skips empty transcripts, hello frames, binary and malformed frames', () => {
    const h = handlers()
    dispatchDictationFrame(JSON.stringify({ type: 'partial', text: '' }), h)
    dispatchDictationFrame(JSON.stringify({ type: 'hello' }), h)
    dispatchDictationFrame(new ArrayBuffer(4), h)
    dispatchDictationFrame('{not json', h)
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled()
  })

  it('keeps a failing handler from reaching the socket', () => {
    const h = handlers()
    h.onFinal.mockImplementation(() => {
      throw new Error('editor gone')
    })
    expect(() => dispatchDictationFrame(JSON.stringify({ type: 'final', text: 'x' }), h)).not.toThrow()
  })
})
