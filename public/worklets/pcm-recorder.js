// AudioWorklet processor that downsamples mic audio to 16-bit PCM at
// whatever sample rate the parent AudioContext is running at, and
// posts chunks back to the main thread every 2048 samples (~128 ms @
// 16 kHz, 8 chunks/second).
//
// Gemini Live expects `audio/pcm;rate=16000` — the caller should
// create the AudioContext with `{ sampleRate: 16000 }` so this
// processor receives float32 samples already at the right rate. We
// do NOT resample here: the browser's native AudioGraph does better
// resampling than a worklet can. If the requested sample rate isn't
// supported (rare; iOS occasionally refuses), the caller must detect
// via `audioContext.sampleRate` and either drop in a resampler or
// bail.
//
// The 2048-sample buffer size is a balance: smaller = lower latency
// for Gemini's VAD, larger = fewer postMessage round-trips. 2048 is
// what Google's own SDK samples use and it works well.

class PcmRecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(2048)
    this.writeIdx = 0
  }

  flush() {
    // Transfer the buffer ownership to avoid a copy — the main thread
    // consumes the ArrayBuffer once and then we allocate a fresh one
    // here for the next chunk.
    const slice = this.buffer.slice(0, this.writeIdx).buffer
    this.port.postMessage({ pcm: slice }, [slice])
    this.buffer = new Int16Array(2048)
    this.writeIdx = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel || channel.length === 0) return true

    for (let i = 0; i < channel.length; i++) {
      // Float [-1..1] → int16. Clamp before scaling to avoid
      // wraparound distortion on loud transients.
      const sample = Math.max(-1, Math.min(1, channel[i]))
      this.buffer[this.writeIdx++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.writeIdx >= this.buffer.length) this.flush()
    }
    return true
  }
}

registerProcessor('pcm-recorder', PcmRecorderWorklet)
