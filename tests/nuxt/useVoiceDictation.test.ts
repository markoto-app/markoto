import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type { DictationFrameHandlers } from '~/composables/ai/dictationPipeline'
import { FINISH_TIMEOUT_MS, useVoiceDictation } from '~/composables/ai/useVoiceDictation'

// The live-dictation state machine. What it must guarantee: words the user
// saw as interim text are committed exactly once, whatever way the session
// ends, and the microphone goes off the moment the user stops.
//
// The socket, the audio graph and the microphone are replaced; the frames a
// relay would send are fed through the socket's handlers.

type SocketHandlers = DictationFrameHandlers & { onDisconnected: () => void, onSocketError: () => void }

const socket = vi.hoisted(() => {
  const holder: { handlers?: SocketHandlers } = {}
  return {
    holder,
    get handlers(): SocketHandlers {
      if (!holder.handlers) throw new Error('useDictationSocket was not called')
      return holder.handlers
    },
    open: vi.fn(),
    sendPcm: vi.fn(),
    sendStop: vi.fn(),
    close: vi.fn()
  }
})
const fakeStream = (): MediaStream => new MediaStream()
const mic = vi.hoisted(() => {
  const stream: { value: MediaStream | undefined } = { value: undefined }
  return { start: vi.fn(), stop: vi.fn(), stream }
})
const pcm = vi.hoisted(() => ({ start: vi.fn(), release: vi.fn() }))

vi.mock('~/composables/ai/dictationSocket', () => ({
  useDictationSocket: (on: SocketHandlers) => {
    socket.holder.handlers = on
    return socket
  }
}))
vi.mock('~/composables/ai/dictationPipeline', () => ({
  createPcmPipeline: () => pcm
}))
vi.mock('@vueuse/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vueuse/core')>()
  return { ...original, useUserMedia: () => mic }
})

registerEndpoint('/api/ai/dictate/token', { method: 'POST', handler: () => ({ token: 'jwt' }) })

async function mountDictation() {
  const onPartial = vi.fn()
  const onFinal = vi.fn()
  const onError = vi.fn()
  const onSessionCap = vi.fn()
  const onIdleTimeout = vi.fn()
  let dictation!: ReturnType<typeof useVoiceDictation>
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      dictation = useVoiceDictation({ docId: 'doc-1', onPartial, onFinal, onError, onSessionCap, onIdleTimeout })
      return () => h('div')
    }
  }))
  return { dictation, wrapper, onPartial, onFinal, onError, onSessionCap, onIdleTimeout }
}

/** Start and bring the session to `recording`, as after the relay's `ready`. */
async function startRecording(dictation: ReturnType<typeof useVoiceDictation>) {
  await dictation.start()
  expect(socket.open).toHaveBeenCalledOnce()
  socket.handlers.onReady()
  await vi.waitFor(() => expect(dictation.state.value).toBe('recording'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mic.stream.value = fakeStream()
  mic.start.mockResolvedValue(mic.stream.value)
  pcm.start.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useVoiceDictation: stopping', () => {
  it('stop → finishing → final → done → idle: the microphone goes off at once, the socket stays open', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('the last words')

    dictation.stop()
    expect(dictation.state.value).toBe('finishing')
    expect(mic.stop).toHaveBeenCalled()
    expect(pcm.release).toHaveBeenCalled()
    expect(socket.sendStop).toHaveBeenCalledOnce()
    expect(socket.close).not.toHaveBeenCalled()
    expect(onFinal).not.toHaveBeenCalled()

    socket.handlers.onFinal('the last words.')
    expect(dictation.state.value).toBe('finishing')
    socket.handlers.onDone()

    expect(dictation.state.value).toBe('idle')
    expect(socket.close).toHaveBeenCalledOnce()
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('the last words.')
  })

  it('a click while finishing neither stops again nor starts a new session', async () => {
    const { dictation } = await mountDictation()
    await startRecording(dictation)
    dictation.stop()

    dictation.toggle()
    dictation.stop()
    await dictation.start()

    expect(dictation.state.value).toBe('finishing')
    expect(socket.sendStop).toHaveBeenCalledOnce()
    expect(socket.open).toHaveBeenCalledOnce()
  })

  it('stop → no answer → the interim text is committed once after the timeout', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    vi.useFakeTimers()
    dictation.stop()
    vi.advanceTimersByTime(FINISH_TIMEOUT_MS - 1)
    expect(dictation.state.value).toBe('finishing')
    expect(onFinal).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(dictation.state.value).toBe('idle')
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('ignores a final that arrives after the fallback commit', async () => {
    const { dictation, onFinal, onPartial } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    vi.useFakeTimers()
    dictation.stop()
    vi.advanceTimersByTime(FINISH_TIMEOUT_MS)
    onPartial.mockClear()

    socket.handlers.onFinal('words on screen.')
    socket.handlers.onPartial('more')
    socket.handlers.onDone()
    socket.handlers.onDisconnected()

    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onPartial).not.toHaveBeenCalled()
    expect(dictation.state.value).toBe('idle')
  })

  it('does not commit again at the timeout when the final already replaced the interim text', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    vi.useFakeTimers()
    dictation.stop()
    socket.handlers.onFinal('words on screen.')
    vi.advanceTimersByTime(FINISH_TIMEOUT_MS)

    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(dictation.state.value).toBe('idle')
  })

  it('commits the interim text when the socket closes while finishing', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')
    dictation.stop()

    socket.handlers.onDisconnected()

    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(dictation.state.value).toBe('idle')
  })

  it('commits the interim text when an error arrives while finishing', async () => {
    const { dictation, onFinal, onError } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')
    dictation.stop()

    socket.handlers.onError()
    socket.handlers.onDisconnected()

    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(onError).toHaveBeenCalledOnce()
    expect(dictation.state.value).toBe('error')
  })

  it('goes straight to idle when stopped before anything was recorded', async () => {
    const { dictation, onFinal } = await mountDictation()
    await dictation.start()
    expect(dictation.state.value).toBe('connecting')

    dictation.stop()

    expect(dictation.state.value).toBe('idle')
    expect(socket.sendStop).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalled()
    expect(onFinal).not.toHaveBeenCalled()
  })
})

describe('useVoiceDictation: sessions the server ends', () => {
  it('commits the interim text when the server closes without warning', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    socket.handlers.onDisconnected()

    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(mic.stop).toHaveBeenCalled()
    expect(dictation.state.value).toBe('idle')
  })

  it.each([
    ['session cap', 'onSessionCap'],
    ['idle timeout', 'onIdleTimeout']
  ] as const)('%s: waits for the trailing final like a stop', async (_name, frame) => {
    const mounted = await mountDictation()
    await startRecording(mounted.dictation)
    socket.handlers.onPartial('words on screen')

    socket.handlers[frame]()
    expect(mounted[frame]).toHaveBeenCalledOnce()
    expect(mounted.dictation.state.value).toBe('finishing')
    expect(mic.stop).toHaveBeenCalled()

    socket.handlers.onFinal('words on screen.')
    socket.handlers.onDone()
    socket.handlers.onDisconnected()

    expect(mounted.onFinal).toHaveBeenCalledTimes(1)
    expect(mounted.onFinal).toHaveBeenCalledWith('words on screen.')
    expect(mounted.dictation.state.value).toBe('idle')
  })

  it.each([
    ['session cap', 'onSessionCap'],
    ['idle timeout', 'onIdleTimeout']
  ] as const)('%s followed by a bare close: the interim text is committed', async (_name, frame) => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    socket.handlers[frame]()
    socket.handlers.onDisconnected()

    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(dictation.state.value).toBe('idle')
  })

  it('commits the interim text when the budget runs out mid-sentence', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('words on screen')

    socket.handlers.onBudgetExhausted(0)

    expect(onFinal).toHaveBeenCalledWith('words on screen')
    expect(dictation.state.value).toBe('error')
  })

  it('keeps only the still-open tail as interim: sentences committed on the way are not committed again', async () => {
    const { dictation, onFinal } = await mountDictation()
    await startRecording(dictation)
    socket.handlers.onPartial('First sentence.')
    socket.handlers.onFinal('First sentence.')
    socket.handlers.onPartial('Second')

    socket.handlers.onDisconnected()

    expect(onFinal.mock.calls.map(c => c[0])).toEqual(['First sentence.', 'Second'])
  })
})
