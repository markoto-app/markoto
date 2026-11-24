// Live voice dictation: mic → AudioWorklet → WebSocket → Mistral
// Voxtral Realtime → interim/final transcripts → consumer inserts
// finals into the editor at the current caret.
//
// Words the user has seen are never dropped: the interim text stays until
// it is committed. Stopping turns the microphone off at once and waits
// (`finishing`) for the relay's trailing `final` and `done`; when the
// session ends any other way with interim text left (timeout, closed
// socket, error), that text is committed as it stands, exactly once.
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
    /** Microphone off, waiting for the trailing transcript. */
    | 'finishing'
    | 'error'

/**
 * How long `finishing` waits for the relay's `done` before the interim text
 * is committed as it stands. The relay itself gives the transcription
 * service 4 s (`END_FLUSH_DEADLINE_MS`) and then sends `done`; one more
 * second covers the way back, so this only fires when the connection is
 * stuck. Longer would leave the button busy for no gain.
 */
export const FINISH_TIMEOUT_MS = 5_000

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

/** The microphone, or why the browser refused it (i18n key under `ai.voiceErrors`). */
async function openMic(start: () => Promise<MediaStream | undefined>): Promise<{ stream: MediaStream } | { problem: 'micDenied' | 'micNotFound' | 'micAccess' }> {
  try {
    // `start()` (not the `enabled` ref) so we know when the stream is live.
    const stream = await start()
    return stream ? { stream } : { problem: 'micAccess' }
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    if (name === 'NotAllowedError') return { problem: 'micDenied' }
    if (name === 'NotFoundError') return { problem: 'micNotFound' }
    return { problem: 'micAccess' }
  }
}

/** Short-lived JWT, minted over POST so it never appears in a URL or log. */
async function mintDictateToken(docId: string): Promise<{ token: string } | { error: unknown }> {
  try {
    const res = await apiFetch('/api/ai/dictate/token', { method: 'post', body: { docId } })
    return { token: res.token }
  } catch (error) {
    return { error }
  }
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
  // The interim text on screen that no `final` has replaced yet.
  let interim = ''
  // False once a session is settled.
  let live = false
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  // Counts starts, so a start that was stopped while it awaited the
  // microphone or the token does not carry on.
  let sessions = 0

  const media = useUserMedia({ constraints: { audio: true } })

  // Haptics: one short tap on start, a double tap on stop; no-op where
  // unsupported (iOS). Patterns are passed per call because
  // UseVibrateOptions.interval is non-optional in the upstream typings.
  const { vibrate } = useVibrate()

  // Frames of a settled session are ignored, so a late `final` can't
  // insert text the fallback already committed.
  const whileLive = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (live) fn(...args)
  }

  const socket = useDictationSocket({
    onReady: whileLive(() => void startPumping()),
    onPartial: whileLive((text: string) => {
      interim = text
      options.onPartial(text)
    }),
    onFinal: whileLive((text: string) => {
      interim = ''
      options.onFinal(text)
    }),
    onDone: () => settle(),
    onBudgetExhausted: whileLive((remaining: number) => {
      options.onBudgetExhausted?.(remaining)
      fail(t('ai.budgetExhaustedTitle'))
    }),
    // The relay ends these like a stop: trailing `final`, `done`, close.
    onSessionCap: whileLive(() => {
      options.onSessionCap?.()
      stop()
    }),
    onIdleTimeout: whileLive(() => {
      options.onIdleTimeout?.()
      stop()
    }),
    onError: whileLive(() => fail(t('ai.voiceErrors.transcription'))),
    // The socket is gone (also without a `done`, e.g. the server went
    // away): nothing more will arrive, so settle with what is on screen.
    onDisconnected: () => settle(),
    onSocketError: whileLive(() => fail(t('ai.voiceErrors.dictationConnection')))
  })

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    errorMessage.value = null
    state.value = 'requesting-permission'
    interim = ''
    live = true
    const session = ++sessions
    const stopped = () => !live || session !== sessions

    const mic = await openMic(media.start)
    if (stopped()) {
      // Stopped while the browser asked for the microphone: release it again.
      if (!live) media.stop()
      return
    }
    if ('problem' in mic) {
      fail(t(`ai.voiceErrors.${mic.problem}`))
      return
    }

    state.value = 'connecting'
    const minted = await mintDictateToken(toValue(options.docId))
    if (stopped()) return
    if ('error' in minted) {
      fail(extractError(minted.error).message)
      return
    }

    // Sent as the first WS frame once connected; the UI locale rides along
    // so Voxtral transcribes in the user's language.
    socket.open({ token: minted.token, languageCode: locale.value })
  }

  async function startPumping() {
    const stream = media.stream.value
    if (!stream) return fail(t('ai.voiceErrors.streamUnavailable'))
    try {
      const wrongRate = await pcm.start(stream, socket.sendPcm)
      // A resampler would be the fix; sending the wrong rate is not.
      if (wrongRate !== null) return fail(t('ai.voiceErrors.sampleRate', { rate: wrongRate }))
      state.value = 'recording'
      vibrate(50)
    } catch {
      fail(t('ai.voiceErrors.pipeline'))
    }
  }

  /**
   * Stop listening. The microphone goes off at once; while recording, the
   * socket stays open (`finishing`) until the relay has sent the trailing
   * transcript and `done`.
   */
  function stop() {
    if (state.value === 'idle' || state.value === 'error' || state.value === 'finishing') return
    const wasRecording = state.value === 'recording'
    if (wasRecording) vibrate([75, 20, 75])
    cleanupAudioResources()

    if (!wasRecording) {
      // Nothing was sent yet, so nothing can come back.
      settle()
      return
    }
    socket.sendStop()
    state.value = 'finishing'
    finishTimer = setTimeout(settle, FINISH_TIMEOUT_MS)
  }

  /**
   * The session is over: commit interim text that no `final` replaced,
   * close the socket and go idle. Safe to call more than once.
   */
  function settle() {
    if (!live) return
    endSession()
    state.value = 'idle'
  }

  function endSession() {
    live = false
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = undefined
    cleanupAudioResources()
    const leftover = interim
    interim = ''
    if (leftover.trim()) options.onFinal(leftover)
    socket.close()
  }

  function fail(message: string) {
    // Also commits the interim text: an error must not take back words
    // the user already saw.
    endSession()
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
    // Wrapping up: a click neither stops again nor starts a second session.
    if (state.value === 'finishing') return
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
    // The editor is going away; committing into it is no longer possible.
    live = false
    if (finishTimer) clearTimeout(finishTimer)
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
