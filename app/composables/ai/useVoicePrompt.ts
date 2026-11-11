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
   * Default 60s — matches the backend's 1024-token output budget.
   */
  maxDurationSec?: number
}

const DEFAULT_MAX_DURATION_SEC = 60
const LEVEL_SAMPLE_COUNT = 64 // visualizer bar count — thin bars read as a smooth wave rather than a chunky equalizer

// MediaRecorder's MIME preference order. Only webm/ogg/wav: Voxtral's
// `/v1/audio/transcriptions` rejects MP4/AAC, which is all Safari's
// MediaRecorder emits, so voice input is Chrome/Firefox-only. Returning
// `undefined` there lets `start()` fail with an "unsupported browser"
// error instead of sending bytes Voxtral will reject.
function pickMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/wav'
  ]
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // Chunk to avoid `Maximum call stack size exceeded` on large buffers —
  // `String.fromCharCode(...bytes)` spreads every byte as an argument.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function useVoicePrompt(opts: UseVoicePromptOptions) {
  // `useI18n()` must run during setup (it throws in the async transcribe
  // path); `locale.value` is read lazily at send time.
  const { locale } = useI18n()
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
  const levels = ref<number[]>(new Array(LEVEL_SAMPLE_COUNT).fill(0))

  const maxDurationSec = opts.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC

  // Native handles stay non-reactive: Vue proxies cause spurious re-renders
  // and can break browser-native event plumbing.
  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rafId: number | null = null
  let startedAt = 0
  // Auto-stop at `maxDurationSec`. cleanupAudioResources stops it on
  // cancel/error so an early stop doesn't leave an orphaned timer.
  const stopTimeout = useTimeoutFn(() => {
    if (state.value === 'recording') stop()
  }, maxDurationSec * 1000, { immediate: false })
  const chunks: Blob[] = []

  function cleanupAudioResources() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    stopTimeout.stop()
    try {
      analyser?.disconnect()
    } catch { /* best-effort */ }
    analyser = null
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => { /* best-effort */ })
    }
    audioCtx = null
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        try {
          track.stop()
        } catch { /* best-effort */ }
      }
      mediaStream = null
    }
    mediaRecorder = null
  }

  function resetState() {
    state.value = 'idle'
    errorMessage.value = null
    durationSec.value = 0
    levels.value = new Array(LEVEL_SAMPLE_COUNT).fill(0)
    chunks.length = 0
  }

  function fail(message: string) {
    cleanupAudioResources()
    errorMessage.value = message
    state.value = 'error'
    durationSec.value = 0
    levels.value = new Array(LEVEL_SAMPLE_COUNT).fill(0)
    chunks.length = 0
  }

  function tickLevels() {
    if (!analyser) return
    const buf = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(buf)

    // Max-pool (not mean) into LEVEL_SAMPLE_COUNT buckets: averages look
    // flat even during speech.
    const binsPerSample = Math.floor(buf.length / LEVEL_SAMPLE_COUNT)
    const out: number[] = new Array(LEVEL_SAMPLE_COUNT)
    for (let i = 0; i < LEVEL_SAMPLE_COUNT; i++) {
      let peak = 0
      const start = i * binsPerSample
      const end = start + binsPerSample
      for (let j = start; j < end; j++) {
        const v = buf[j] ?? 0
        if (v > peak) peak = v
      }
      // Scale 0..255 → 0..1 with a mild curve so quiet speech still shows.
      out[i] = Math.min(1, (peak / 255) ** 0.7)
    }
    levels.value = out

    if (startedAt) {
      durationSec.value = (Date.now() - startedAt) / 1000
    }
    rafId = requestAnimationFrame(tickLevels)
  }

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    resetState()
    state.value = 'requesting-permission'

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail('Voice input is not supported in this browser.')
      return
    }

    const stream = await acquireUserMedia()
    if (!stream) return
    mediaStream = stream

    const mimeType = pickMimeType()
    if (!mimeType) {
      fail('Audio recording is not supported in this browser.')
      return
    }

    const recorder = instantiateRecorder(stream, mimeType)
    if (!recorder) return

    setupAnalyser(stream)
    recorder.start()
    startedAt = Date.now()
    state.value = 'recording'
    rafId = requestAnimationFrame(tickLevels)

    // Hitting the cap calls `stop()` (not `cancel`) so the audio is still transcribed.
    stopTimeout.start()
  }

  /** Returns null on any failure (already routed to fail()). */
  async function acquireUserMedia(): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      // NotAllowedError = dismissed or blocked, NotFoundError = no hardware.
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError') {
        fail('Microphone permission denied.')
      } else if (name === 'NotFoundError') {
        fail('No microphone found.')
      } else {
        fail(e instanceof Error ? e.message : 'Could not access microphone.')
      }
      return null
    }
  }

  /**
   * `onstop` fires after `stop()` drains the final chunk, so transcription
   * starts there and both "user clicked stop" and "hit max duration" share
   * one path. Returns null on construction failure (already routed to fail()).
   */
  function instantiateRecorder(stream: MediaStream, mimeType: string): MediaRecorder | null {
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not start recorder.')
      return null
    }
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data)
    }
    recorder.onstop = () => {
      void finalizeAndTranscribe(mimeType)
    }
    recorder.onerror = (ev) => {
      const err = (ev as unknown as { error?: Error }).error
      fail(err?.message || 'Recording failed.')
    }
    mediaRecorder = recorder
    return recorder
  }

  /**
   * Analyser for the visualizer, sharing the MediaStream. fftSize 256 =
   * 128 bins, enough for LEVEL_SAMPLE_COUNT buckets. Failure is
   * non-fatal: recording works without bars.
   */
  function setupAnalyser(stream: MediaStream): void {
    try {
      audioCtx = new (globalThis.AudioContext || (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
    } catch {
      analyser = null
    }
  }

  function stop() {
    if (state.value !== 'recording') return
    // 'transcribing' is set by `finalizeAndTranscribe` once `onstop` fires;
    // setting it here would show it while the last audio bytes are pending.
    try {
      mediaRecorder?.stop()
    } catch {
      fail('Could not stop recording.')
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

    if (chunks.length === 0) {
      fail('No audio was captured.')
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    chunks.length = 0

    // Very short recordings yield near-empty blobs; the server rejects
    // under 100 bytes, this gives a cleaner error.
    if (blob.size < 256) {
      fail('Recording was too short.')
      return
    }

    let audioB64: string
    try {
      audioB64 = await blobToBase64(blob)
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not encode audio.')
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

  onUnmounted(() => {
    cleanupAudioResources()
  })

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
