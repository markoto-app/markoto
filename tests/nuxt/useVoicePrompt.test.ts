// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { H3Event } from 'h3'
import { setResponseStatus } from 'h3'

// Voice input whose transcription is refused because the AI Points are
// used up: the composable keeps the API code next to the message, so the
// prompt bar can show the ways forward instead of a bare error. The
// browser's microphone and recorder are replaced by fakes.

const recorder = vi.hoisted(() => ({ onStop: null as null | (() => void) }))
vi.mock('~/composables/ai/voiceCapture', () => ({
  silentLevels: () => [0],
  pickMimeType: () => 'audio/webm',
  openMicrophone: async () => ({ stream: {} }),
  createRecorder: (_s: unknown, _m: string, on: { onStop: () => void }) => {
    recorder.onStop = on.onStop
    return { start: () => {}, stop: () => recorder.onStop?.(), onstop: null }
  },
  takeClip: () => new Blob(['x']),
  encodeClip: async () => 'eA==',
  createMicCapture: () => ({ hold: () => {}, setupAnalyser: () => {}, startMeter: () => {}, release: () => {} })
}))

let answer: { status: number, body: unknown } = { status: 200, body: { text: 'hello' } }
registerEndpoint('/api/ai/transcribe', {
  method: 'POST',
  handler: (event: H3Event) => {
    setResponseStatus(event, answer.status)
    return answer.body
  }
})

const { useVoicePrompt } = await import('~/composables/ai/useVoicePrompt')

async function record(onTranscript = vi.fn()) {
  vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: async () => ({}) } })
  let voice: ReturnType<typeof useVoicePrompt> | null = null
  await mountSuspended(defineComponent({
    setup() {
      voice = useVoicePrompt({ onTranscript })
      return () => h('div')
    }
  }))
  await voice!.start()
  expect(voice!.state.value).toBe('recording')
  voice!.stop()
  await flushPromises()
  await vi.waitFor(() => expect(voice!.state.value).not.toBe('transcribing'))
  return voice!
}

describe('useVoicePrompt: transcription refused', () => {
  it('out of AI Points: error state with the code, for the way forward', async () => {
    answer = { status: 402, body: { statusCode: 402, message: 'AI Points exhausted.', data: { code: 'ai/budget-exhausted' } } }
    const voice = await record()
    expect(voice.state.value).toBe('error')
    expect(voice.errorCode.value).toBe('ai/budget-exhausted')
    voice.clearError()
    expect(voice.errorMessage.value).toBeNull()
  })

  it('a transcript is handed on and leaves no error code', async () => {
    answer = { status: 200, body: { text: 'hello' } }
    const onTranscript = vi.fn()
    const voice = await record(onTranscript)
    expect(onTranscript).toHaveBeenCalledWith('hello')
    expect(voice.errorCode.value).toBeNull()
  })
})
