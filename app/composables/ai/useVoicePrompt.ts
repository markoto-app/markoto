import { createMicCapture, createRecorder, encodeClip, openMicrophone, pickMimeType, silentLevels, takeClip } from './voiceCapture'

// Voice-input state machine for the AI prompt bar.
//
// Flow:
//   idle → [click mic] → requestingPermission → recording → [click stop]
//        → transcribing → done (auto-submit fires) → idle
//   Any step can transition to `error` with a human-readable message.
//
// MediaRecorder + MediaStream are cleaned up on every exit path (stop,
// cancel, unmount, error) so the browser's microphone indicator clears.
//
// `levels` is a small ring of 0..1 amplitude samples that the waveform
// component reads each frame. The RAF loop lives here, not in the
// component, so any state transition can stop it.

export type VoicePromptState
  = | 'idle'
    | 'requesting-permission'
    | 'recording'
    | 'transcribing'
    | 'error'

export interface UseVoicePromptOptions {
  /**
   * Called when transcription succeeds. The composable doesn't know what
   * "submit" means; the consumer wires this to the real submit handler.
   */
  onTranscript: (text: string) => void | Promise<void>
  /**
   * Called when the user speaks but the transcription model couldn't
   * make out anything intelligible. Lets the consumer surface a
   * "didn't catch that" toast without the composable owning toast UI.
   */
  onInaudible?: () => void
  /**
   * Hard cap on recording length. Reaching this auto-stops and transcribes.
   * Default 60s: matches the backend's 1024-token output budget.
   */
  maxDurationSec?: number
}

const DEFAULT_MAX_DURATION_SEC = 60

export function useVoicePrompt(opts: UseVoicePromptOptions) {
  // `useI18n()` must run during setup (it throws in the async transcribe
  // path); `locale.value` is read lazily at send time.
  const { locale, t } = useI18n()
  const { extractError } = useErrorHandler()
  // The open document's workspace: its Team / Business plan may include
  // voice where the personal plan doesn't.
  const aiWorkspace = useAiWorkspaceContext()

  // Lets the UI disable the button before a click hits NotAllowedError.
  // `'unsupported'` on Firefox + iOS Safari (no Permissions API for
  // `microphone`) means "unknown", not blocked.
  const micPermission = usePermission('microphone', { controls: false })

  const state = ref<VoicePromptState>('idle')
  const errorMessage = ref<string | null>(null)
  const durationSec = ref(0)
  const levels = ref<number[]>(silentLevels())

  const maxDurationSec = opts.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC

  let mediaRecorder: MediaRecorder | null = null
  let startedAt = 0
  const capture = createMicCapture((next) => {
    levels.value = next
    if (startedAt) {
      durationSec.value = (Date.now() - startedAt) / 1000
    }
  })
  // Auto-stop at `maxDurationSec`. cleanupAudioResources stops it on
  // cancel/error so an early stop doesn't leave an orphaned timer.
  const stopTimeout = useTimeoutFn(() => {
    if (state.value === 'recording') stop()
  }, maxDurationSec * 1000, { immediate: false })
  const chunks: Blob[] = []

  function cleanupAudioResources() {
    stopTimeout.stop()
    capture.release()
    mediaRecorder = null
  }

  function resetState() {
    state.value = 'idle'
    errorMessage.value = null
    durationSec.value = 0
    levels.value = silentLevels()
    chunks.length = 0
  }

  function fail(message: string) {
    cleanupAudioResources()
    errorMessage.value = message
    state.value = 'error'
    durationSec.value = 0
    levels.value = silentLevels()
    chunks.length = 0
  }

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    resetState()
    state.value = 'requesting-permission'

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail(t('ai.voiceErrors.unsupportedVoice'))
      return
    }

    const mic = await openMicrophone()
    if ('problem' in mic) {
      fail(t(`ai.voiceErrors.${mic.problem}`))
      return
    }
    const stream = mic.stream
    capture.hold(stream)

    const mimeType = pickMimeType()
    if (!mimeType) {
      fail(t('ai.voiceErrors.unsupportedRecording'))
      return
    }

    const recorder = instantiateRecorder(stream, mimeType)
    if (!recorder) return

    capture.setupAnalyser(stream)
    recorder.start()
    startedAt = Date.now()
    state.value = 'recording'
    capture.startMeter()

    // Hitting the cap calls `stop()` (not `cancel`) so the audio is still transcribed.
    stopTimeout.start()
  }

  /**
   * `onstop` fires after `stop()` drains the final chunk, so transcription
   * starts there and both "user clicked stop" and "hit max duration" share
   * one path. Returns null on construction failure (already routed to fail()).
   */
  function instantiateRecorder(stream: MediaStream, mimeType: string): MediaRecorder | null {
    const recorder = createRecorder(stream, mimeType, {
      onData: blob => chunks.push(blob),
      onStop: () => void finalizeAndTranscribe(mimeType),
      onError: () => fail(t('ai.voiceErrors.recordingFailed'))
    })
    if (!recorder) fail(t('ai.voiceErrors.recorderStart'))
    mediaRecorder = recorder
    return recorder
  }

  function stop() {
    if (state.value !== 'recording') return
    // 'transcribing' is set by `finalizeAndTranscribe` once `onstop` fires;
    // setting it here would show it while the last audio bytes are pending.
    try {
      mediaRecorder?.stop()
    } catch {
      fail(t('ai.voiceErrors.stopFailed'))
    }
  }

  function cancel() {
    if (state.value === 'idle') return
    // Clearing `onstop` keeps the cancelled clip from being transcribed.
    if (mediaRecorder) mediaRecorder.onstop = null
    try {
      mediaRecorder?.stop()
    } catch { /* best-effort */ }
    cleanupAudioResources()
    resetState()
  }

  async function finalizeAndTranscribe(mimeType: string) {
    // Release the stream now so the mic indicator clears before the fetch resolves.
    cleanupAudioResources()
    state.value = 'transcribing'

    const blob = takeClip(chunks, mimeType)
    if (typeof blob === 'string') {
      fail(t(`ai.voiceErrors.${blob}`))
      return
    }

    const audioB64 = await encodeClip(blob)
    if (audioB64 === null) {
      fail(t('ai.voiceErrors.encodeFailed'))
      return
    }

    try {
      // The UI locale as `languageCode`; the server normalizer accepts both
      // BCP-47 (`de-DE`) and the short ISO 639-1 code (`de`).
      const res = await apiFetch('/api/ai/transcribe', {
        method: 'post',
        body: { audio: audioB64, mimeType, languageCode: locale.value, ...(aiWorkspace.value ? { workspaceId: aiWorkspace.value } : {}) }
      })
      if (res.inaudible || !res.text) {
        resetState()
        opts.onInaudible?.()
        return
      }
      // Reset first so the UI is idle by the time the consumer's submit lands.
      resetState()
      await opts.onTranscript(res.text)
    } catch (e) {
      fail(extractError(e).message)
    }
  }

  function clearError() {
    if (state.value === 'error') resetState()
  }

  function toggle() {
    if (state.value === 'recording') stop()
    else if (state.value === 'idle' || state.value === 'error') void start()
  }

  onUnmounted(cleanupAudioResources)

  return {
    state: readonly(state),
    errorMessage: readonly(errorMessage),
    durationSec: readonly(durationSec),
    levels: readonly(levels),
    maxDurationSec,
    micPermission,
    start,
    stop,
    cancel,
    toggle,
    clearError
  }
}
