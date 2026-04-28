// Voice-input state machine for the AI prompt bar.
//
// Flow:
//   idle → [click mic] → requestingPermission → recording → [click stop]
//        → transcribing → done (auto-submit fires) → idle
//   Any step can transition to `error` with a human-readable message.
//
// MediaRecorder + MediaStream are explicitly cleaned up on every exit path
// (stop, cancel, unmount, error) so the browser's "site is using your
// microphone" indicator clears immediately — leaving the track dangling
// after an aborted recording is the most visible UX bug in naive impls.
//
// `levels` is a small ring of 0..1 amplitude samples that the waveform
// component reads each frame. We own the RAF loop here (not in the
// component) so the composable can kill it from any state transition
// without the component having to listen for that.

export type VoicePromptState
  = | 'idle'
    | 'requesting-permission'
    | 'recording'
    | 'transcribing'
    | 'error'

export interface UseVoicePromptOptions {
  /**
   * Called when transcription succeeds. The client auto-submits whatever
   * text comes back — the composable is intentionally kind-agnostic about
   * what "submit" means; the consumer wires it to the real submit handler.
   */
  onTranscript: (text: string) => void | Promise<void>
  /**
   * Called when the user speaks but Gemini couldn't make out anything
   * intelligible. Lets the consumer surface a "didn't catch that" toast
   * without the composable owning toast UI.
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

// MediaRecorder's MIME preference order.
//
// We only return opus-based containers because Cloud Speech-to-Text's
// sync `recognize` endpoint supports WEBM_OPUS / OGG_OPUS / LINEAR16
// but NOT MP4/AAC. Safari's MediaRecorder currently only emits
// `audio/mp4` (AAC) — so voice input is effectively Chrome/Firefox-
// only until we add a server-side transcoder or switch to the Cloud
// STT batch Files API (which does accept MP4). Returning `undefined`
// on Safari lets `start()` fail with a friendly "unsupported browser"
// error rather than shipping bytes that Cloud STT will reject.
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
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function useVoicePrompt(opts: UseVoicePromptOptions) {
  // Capture i18n at setup time — useI18n throws "Must be called at the
  // top of a `setup` function" if called inside the async transcribe
  // path. We read `locale.value` lazily at send time so language
  // changes still propagate without a re-invocation.
  const { locale } = useI18n()

  // Reactive mic permission. Lets the UI gray out the button + show
  // "Mic blocked in browser settings" without the user having to click
  // and hit a NotAllowedError. `'unsupported'` on Firefox + iOS Safari
  // (no Permissions API for `microphone`); we treat those as "unknown,
  // don't preemptively block".
  const micPermission = usePermission('microphone', { controls: false })

  const state = ref<VoicePromptState>('idle')
  const errorMessage = ref<string | null>(null)
  const durationSec = ref(0)
  const levels = ref<number[]>(new Array(LEVEL_SAMPLE_COUNT).fill(0))

  const maxDurationSec = opts.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC

  // Native handles — held in non-reactive refs because attaching Vue
  // reactivity to a MediaStream/AudioContext triggers spurious re-renders
  // and can even break some browser-native event plumbing.
  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rafId: number | null = null
  let startedAt = 0
  // Hard-cap auto-stop timer — fires once `maxDurationSec` after start.
  // useTimeoutFn auto-cleans on scope dispose; we still call .stop()
  // from cleanupAudioResources for the cancel/error paths so a user
  // who clicks stop early doesn't get an orphaned auto-stop.
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
      // AudioContext.close() returns a promise — we don't await it because
      // cleanup happens on teardown paths where awaiting would needlessly
      // block state transitions.
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

    // Downsample the frequency bin array to LEVEL_SAMPLE_COUNT buckets by
    // max-pooling. Max-pool (not mean) because visual loudness cares more
    // about peaks than averages — flat averages look dead even during speech.
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

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      // Chrome throws NotAllowedError on dismiss-or-block, NotFoundError on
      // missing hardware. Both messages are user-intelligible so surface them.
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError') {
        fail('Microphone permission denied.')
      } else if (name === 'NotFoundError') {
        fail('No microphone found.')
      } else {
        fail(e instanceof Error ? e.message : 'Could not access microphone.')
      }
      return
    }
    mediaStream = stream

    const mimeType = pickMimeType()
    if (!mimeType) {
      fail('Audio recording is not supported in this browser.')
      return
    }

    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType })
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not start recorder.')
      return
    }

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data)
    }
    // onstop fires after stop() drains the final chunk, which is the point
    // at which we know the full Blob is ready. Trigger transcription here
    // rather than from the caller so both "user clicked stop" and "hit max
    // duration" paths share one code path.
    mediaRecorder.onstop = () => {
      void finalizeAndTranscribe(mimeType)
    }
    mediaRecorder.onerror = (ev) => {
      const err = (ev as unknown as { error?: Error }).error
      fail(err?.message || 'Recording failed.')
    }

    // Analyser for the visualizer — shares the MediaStream, doesn't duplicate
    // the audio path. fftSize 256 = 128 frequency bins, plenty for 32 bars.
    try {
      audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
    } catch {
      // Visualiser failure is non-fatal — recording still works without bars.
      analyser = null
    }

    mediaRecorder.start()
    startedAt = Date.now()
    state.value = 'recording'
    rafId = requestAnimationFrame(tickLevels)

    // Hard cap. Using `stop()` (not `cancel`) so the recorded audio still
    // gets transcribed — user hit the cap but presumably wanted what they
    // said to go through.
    stopTimeout.start()
  }

  function stop() {
    if (state.value !== 'recording') return
    // Don't flip to 'transcribing' yet — the recorder's `onstop` fires after
    // the final chunk is drained; `finalizeAndTranscribe` sets the state
    // then. Flipping it here leaves a window where the UI says "transcribing"
    // but we're still waiting for the last audio bytes.
    try {
      mediaRecorder?.stop()
    } catch {
      fail('Could not stop recording.')
    }
  }

  function cancel() {
    if (state.value === 'idle') return
    // `null`-ing `onstop` before stop() prevents the recorded clip from
    // racing to transcription after a cancel.
    if (mediaRecorder) mediaRecorder.onstop = null
    try {
      mediaRecorder?.stop()
    } catch { /* best-effort */ }
    cleanupAudioResources()
    resetState()
  }

  async function finalizeAndTranscribe(mimeType: string) {
    // At this point the recorder is done but the audio stream + analyser
    // are still live — release them now so the browser mic indicator
    // clears immediately rather than waiting for the fetch to resolve.
    cleanupAudioResources()
    state.value = 'transcribing'

    if (chunks.length === 0) {
      fail('No audio was captured.')
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    chunks.length = 0

    // Filter a useless MP4 "silence/noise" chunk that Safari sometimes
    // emits on very short recordings (<300ms). The server will reject
    // anything under 100 bytes, but we short-circuit here for a cleaner
    // error.
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
      // `languageCode` piggybacks the UI locale so a German speaker
      // doesn't get English transcription. Cloud STT accepts either a
      // BCP-47 tag (`de-DE`) or, via our server-side normalizer, the
      // short ISO 639-1 code (`de`) we store for the UI. `locale` was
      // captured at setup-time (see top of composable).
      const res = await $fetch<{ text: string, inaudible: boolean }>('/api/ai/transcribe', {
        method: 'POST',
        body: { audio: audioB64, mimeType, languageCode: locale.value }
      })
      if (res.inaudible || !res.text) {
        resetState()
        opts.onInaudible?.()
        return
      }
      // Hand off the transcript to the consumer. Reset to idle first so the
      // UI is back in its resting state by the time the submit lands; the
      // consumer then flips into its own submitting state.
      resetState()
      await opts.onTranscript(res.text)
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      fail(err.data?.message || err.message || 'Transcription failed.')
    }
  }

  // Clear the error state without starting a new recording — lets the
  // consumer dismiss an error toast.
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

export type UseVoicePromptReturn = ReturnType<typeof useVoicePrompt>
