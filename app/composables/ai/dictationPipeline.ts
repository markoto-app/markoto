// The pieces of live dictation (`useVoiceDictation`) that don't need the
// composable's state: the 16 kHz PCM capture graph, and the dispatch of the
// relay's server frames.
import type { DictateServerFrame } from '~~/shared/contracts/dictateWs'

/**
 * Mic stream → AudioWorklet (`/worklets/pcm-recorder.js`) → 16 kHz PCM
 * buffers. The audio nodes are held outside reactivity: they don't play well
 * with Vue's Proxy wrapping.
 */
export function createPcmPipeline() {
  let audioCtx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null

  /**
   * Starts feeding `onPcm`. `audio/pcm;rate=16000` requires the AudioContext
   * itself to run at 16 kHz; the worklet does not resample, so a browser
   * that ignores the sampleRate hint (iOS Safari sometimes) gets its rate
   * back instead of a running graph. Throws when the graph can't be built.
   */
  async function start(stream: MediaStream, onPcm: (pcm: ArrayBuffer) => void): Promise<number | null> {
    audioCtx = new AudioContext({ sampleRate: 16000 })
    if (audioCtx.sampleRate !== 16000) return audioCtx.sampleRate
    await audioCtx.audioWorklet.addModule('/worklets/pcm-recorder.js')
    source = audioCtx.createMediaStreamSource(stream)
    worklet = new AudioWorkletNode(audioCtx, 'pcm-recorder')
    worklet.port.onmessage = (ev) => {
      const pcm = (ev.data as { pcm?: ArrayBuffer }).pcm
      if (pcm) onPcm(pcm)
    }
    source.connect(worklet)
    // Not connected to `destination`: no local playback, and Chrome and
    // Firefox pump the graph as long as a MediaStreamSource feeds it.
    return null
  }

  function release(): void {
    try {
      worklet?.disconnect()
    } catch { /* best-effort */ }
    worklet = null
    try {
      source?.disconnect()
    } catch { /* best-effort */ }
    source = null
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => { /* best-effort */ })
    }
    audioCtx = null
  }

  return { start, release }
}

export interface DictationFrameHandlers {
  /** Auth + STT stream both up: safe to start sending audio. */
  onReady: () => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onBudgetExhausted: (remaining: number) => void
  onSessionCap: () => void
  onIdleTimeout: () => void
  /** Every transcript of the session was sent; the socket closes next. */
  onDone: () => void
  onError: () => void
}

function routeFrame(msg: DictateServerFrame, on: DictationFrameHandlers): void {
  switch (msg.type) {
    case 'hello':
      // Auth was already sent when the socket opened; nothing to do.
      break
    case 'ready':
      on.onReady()
      break
    case 'partial':
      if (msg.text) on.onPartial(msg.text)
      break
    case 'final':
      if (msg.text) on.onFinal(msg.text)
      break
    case 'budget-exhausted':
      on.onBudgetExhausted(msg.remaining)
      break
    case 'session-cap':
      on.onSessionCap()
      break
    case 'idle-timeout':
      on.onIdleTimeout()
      break
    case 'done':
      on.onDone()
      break
    case 'error':
      on.onError()
      break
  }
}

/** Routes one text frame from the dictation relay; malformed frames (and handler failures) are ignored. */
export function dispatchDictationFrame(data: unknown, on: DictationFrameHandlers): void {
  if (typeof data !== 'string') return
  try {
    // Typed against the shared union so a new server frame type must be handled here.
    routeFrame(JSON.parse(data) as DictateServerFrame, on)
  } catch { /* ignore malformed frames */ }
}
