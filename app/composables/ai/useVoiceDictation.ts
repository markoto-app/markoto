// Live voice dictation: mic → AudioWorklet → WebSocket → Mistral
// Voxtral Realtime → interim/final transcripts → consumer inserts
// finals into the editor at the current caret.
//
// Deliberately thin: the consumer (`EditorLayout`) owns the editor
// view + Y.js integration, this composable just streams bytes and
// surfaces state.
//
// Built on VueUse primitives: `useUserMedia` handles the MediaStream
// lifecycle + explicit track.stop() on unmount / stop; the socket is
// `useDictationSocket` (dictationSocket.ts, on `useWebSocket`).

import { useUserMedia, useVibrate } from '@vueuse/core'
import { createPcmPipeline } from './dictationPipeline'
import { useDictationSocket } from './dictationSocket'

export type VoiceDictationState
  = | 'idle'
    | 'requesting-permission'
    | 'connecting'
    | 'recording'
    | 'error'

export interface UseVoiceDictationOptions {
  docId: MaybeRefOrGetter<string>
  /** Called each time Voxtral emits an interim transcript chunk. */
  onPartial: (text: string) => void
  /**
   * Called when Voxtral finalizes a phrase. The consumer is
   * responsible for committing the text into the doc (typically via
   * a Y.js transact at the current caret).
   */
  onFinal: (text: string) => void
  /**
   * Called on any fatal error. Composable transitions to `error`
   * state; consumer should surface a toast / UI.
   */
  onError?: (message: string) => void
  /**
   * Called when the server closes us because the daily budget is
   * exhausted or the session hit its 10-min cap. Consumer typically
   * shows a friendly "out of minutes" / "session ended" UI.
   */
  onBudgetExhausted?: (remaining: number) => void
  onSessionCap?: () => void
  onIdleTimeout?: () => void
}

export function useVoiceDictation(options: UseVoiceDictationOptions) {
  // `useI18n()` must run synchronously during setup (it throws inside an
  // async click handler); `locale.value` is read lazily so language changes
  // are still picked up.
  const { locale, t } = useI18n()
  const { extractError } = useErrorHandler()

  const state = ref<VoiceDictationState>('idle')
  const errorMessage = ref<string | null>(null)

  // The capture graph, built after the user clicks the mic.
  const pcm = createPcmPipeline()
  let closing = false

  const media = useUserMedia({ constraints: { audio: true } })

  // Haptics: one short tap on start, a double tap on stop; no-op where
  // unsupported (iOS). Patterns are passed per call because
  // UseVibrateOptions.interval is non-optional in the upstream typings.
  const { vibrate } = useVibrate()

  const socket = useDictationSocket({
    onReady: () => void startPumping(),
    onPartial: options.onPartial,
    onFinal: options.onFinal,
    onBudgetExhausted: (remaining) => {
      options.onBudgetExhausted?.(remaining)
      fail(t('ai.dictateBudgetExhaustedTitle'))
    },
    onSessionCap: () => {
      options.onSessionCap?.()
      stop()
    },
    onIdleTimeout: () => {
      options.onIdleTimeout?.()
      stop()
    },
    onError: () => fail(t('ai.voiceErrors.transcription')),
    onDisconnected: () => {
      if (!closing && state.value !== 'error') {
        // Unexpected server close: soft stop so the UI doesn't look stuck.
        stop()
      }
    },
    onSocketError: () => fail(t('ai.voiceErrors.dictationConnection'))
  })

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    errorMessage.value = null
    state.value = 'requesting-permission'
    closing = false

    // `start()` (not the `enabled` ref) so we know when the stream is live.
    let stream: MediaStream | undefined
    try {
      stream = await media.start()
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError') fail(t('ai.voiceErrors.micDenied'))
      else if (name === 'NotFoundError') fail(t('ai.voiceErrors.micNotFound'))
      else fail(t('ai.voiceErrors.micAccess'))
      return
    }
    if (!stream) {
      fail(t('ai.voiceErrors.micAccess'))
      return
    }

    state.value = 'connecting'

    // Short-lived JWT, minted over POST so it never appears in a URL or log.
    let token: string
    try {
      const res = await apiFetch('/api/ai/dictate/token', {
        method: 'post',
        body: { docId: toValue(options.docId) }
      })
      token = res.token
    } catch (e) {
      fail(extractError(e).message)
      return
    }

    // Sent as the first WS frame once connected; the UI locale rides along
    // so Voxtral transcribes in the user's language.
    socket.open({ token, languageCode: locale.value })
  }

  async function startPumping() {
    const stream = media.stream.value
    if (!stream) {
      fail(t('ai.voiceErrors.streamUnavailable'))
      return
    }

    try {
      const wrongRate = await pcm.start(stream, socket.sendPcm)
      if (wrongRate !== null) {
        // A resampler would be the fix; sending the wrong rate is not.
        fail(t('ai.voiceErrors.sampleRate', { rate: wrongRate }))
        return
      }
      state.value = 'recording'
      vibrate(50)
    } catch {
      fail(t('ai.voiceErrors.pipeline'))
    }
  }

  function stop() {
    if (state.value === 'idle') return
    if (state.value === 'recording') vibrate([75, 20, 75])
    closing = true

    socket.sendStop()

    cleanupAudioResources()
    // Delay the close so the trailing `final` lands before onDisconnected fires.
    setTimeout(socket.close, 300)

    state.value = 'idle'
  }

  function fail(message: string) {
    cleanupAudioResources()
    socket.close()
    options.onError?.(message)
    errorMessage.value = message
    state.value = 'error'
  }

  function clearError() {
    if (state.value === 'error') {
      errorMessage.value = null
      state.value = 'idle'
    }
  }

  function toggle() {
    if (state.value === 'recording' || state.value === 'connecting' || state.value === 'requesting-permission') {
      stop()
    } else {
      void start()
    }
  }

  function cleanupAudioResources() {
    pcm.release()
    // Clears the browser's mic indicator immediately.
    media.stop()
  }

  onUnmounted(() => {
    closing = true
    cleanupAudioResources()
    socket.close()
  })

  return {
    state: readonly(state),
    errorMessage: readonly(errorMessage),
    start,
    stop,
    toggle,
    clearError
  }
}
