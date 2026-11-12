// Microphone capture for the AI prompt bar's voice input (`useVoicePrompt`):
// the MediaStream, the Web Audio analyser behind the waveform, and the
// recorded clip's encoding. The native handles stay non-reactive here: Vue
// proxies cause spurious re-renders and can break browser-native event
// plumbing.

/** Visualizer bar count: thin bars read as a smooth wave rather than a chunky equalizer. */
export const LEVEL_SAMPLE_COUNT = 64

export function silentLevels(): number[] {
  return new Array(LEVEL_SAMPLE_COUNT).fill(0)
}

// MediaRecorder's MIME preference order. Only webm/ogg/wav: Voxtral's
// `/v1/audio/transcriptions` rejects MP4/AAC, which is all Safari's
// MediaRecorder emits, so voice input is Chrome/Firefox-only. Returning
// `undefined` there lets `start()` fail with an "unsupported browser"
// error instead of sending bytes Voxtral will reject.
export function pickMimeType(): string | undefined {
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

/** The microphone, or why the browser refused it (i18n key under `ai.voiceErrors`). */
export async function openMicrophone(): Promise<{ stream: MediaStream } | { problem: 'micDenied' | 'micNotFound' | 'micAccess' }> {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }) }
  } catch (e) {
    // NotAllowedError = dismissed or blocked, NotFoundError = no hardware.
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError') return { problem: 'micDenied' }
    if (name === 'NotFoundError') return { problem: 'micNotFound' }
    return { problem: 'micAccess' }
  }
}

/** Null when the browser can't record this stream in `mimeType`. */
export function createRecorder(stream: MediaStream, mimeType: string, on: { onData: (chunk: Blob) => void, onStop: () => void, onError: () => void }): MediaRecorder | null {
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType })
  } catch {
    return null
  }
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) on.onData(ev.data)
  }
  recorder.onstop = on.onStop
  recorder.onerror = on.onError
  return recorder
}

/**
 * The recorded chunks as one clip (emptying `chunks`), or why there is
 * nothing worth sending (i18n key under `ai.voiceErrors`).
 */
export function takeClip(chunks: Blob[], mimeType: string): Blob | 'noAudio' | 'tooShort' {
  if (chunks.length === 0) return 'noAudio'
  const blob = new Blob(chunks, { type: mimeType })
  chunks.length = 0
  // Very short recordings yield near-empty blobs; the server rejects
  // under 100 bytes, this gives a cleaner error.
  return blob.size < 256 ? 'tooShort' : blob
}

/** The recorded clip as base64, or null when it can't be encoded. */
export async function encodeClip(blob: Blob): Promise<string | null> {
  try {
    return await blobToBase64(blob)
  } catch {
    return null
  }
}

/**
 * Max-pool (not mean) the analyser's spectrum into LEVEL_SAMPLE_COUNT
 * buckets: averages look flat even during speech.
 */
function sampleLevels(analyser: AnalyserNode): number[] {
  const buf = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(buf)
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
  return out
}

/**
 * The microphone of one recording and its level meter. `onFrame` gets the
 * levels once per animation frame while the meter runs (no frames when the
 * analyser couldn't be set up: recording works without bars).
 */
export function createMicCapture(onFrame: (levels: number[]) => void) {
  let mediaStream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rafId: number | null = null

  function tick() {
    if (!analyser) return
    onFrame(sampleLevels(analyser))
    rafId = requestAnimationFrame(tick)
  }

  /** The recording's microphone, released by `release()`. */
  function hold(stream: MediaStream): void {
    mediaStream = stream
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

  function startMeter(): void {
    rafId = requestAnimationFrame(tick)
  }

  /** Stops the meter and releases the microphone, so the browser's indicator clears. */
  function release(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
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
  }

  return { hold, setupAnalyser, startMeter, release }
}
