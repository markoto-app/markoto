import { EventEmitter } from 'node:events'
import {
  AudioEncoding,
  RealtimeTranscription
} from '@mistralai/mistralai/extra/realtime'

// Factory for the dictate streaming client. Phase 7: cloud-stt path
// removed — voxtral realtime is the only path. The mock-streaming
// fixture stays so integration tests can drive the WS handshake
// without a real upstream (gated on `TEST_MODE=1 + NUXT_VOXTRAL_REALTIME_MOCK=1`,
// or for backwards-compat the legacy `NUXT_GOOGLE_SPEECH_MOCK=1`).

export interface StreamingRecognizeRequest {
  config: {
    encoding: string
    sampleRateHertz: number
    languageCode: string
    enableAutomaticPunctuation?: boolean
    model?: string
  }
  interimResults: boolean
}

export interface SpeechStream {
  write(chunk: Buffer): boolean
  end(): void
  on(ev: string, cb: (arg?: unknown) => void): void
  destroy(err?: unknown): void
}

export interface SpeechClientLike {
  streamingRecognize(req: StreamingRecognizeRequest): SpeechStream
}

/**
 * Thresholds for the fake stream's canned output, tuned so a test
 * can feed a handful of chunks and see each state transition
 * (partial grows, finalizes, another partial, another final). Chunk
 * indices are deliberately small so tests don't have to pump
 * hundreds of bytes.
 */
const MOCK_SEQUENCE: Array<{
  atChunk: number
  event: { text: string, isFinal: boolean }
}> = [
  { atChunk: 1, event: { text: 'hello', isFinal: false } },
  { atChunk: 2, event: { text: 'hello world', isFinal: false } },
  { atChunk: 3, event: { text: 'hello world', isFinal: true } },
  { atChunk: 5, event: { text: 'how', isFinal: false } },
  { atChunk: 6, event: { text: 'how are you', isFinal: true } }
]

class MockSpeechStream extends EventEmitter implements SpeechStream {
  private chunks = 0
  private ended = false

  write(_chunk: Buffer): boolean {
    if (this.ended) {
      // Mirror the real stream's behavior: writing after end emits an
      // error event with "write after end". Tests for the server's
      // straggler-chunk guard rely on this.
      queueMicrotask(() => this.emit('error', new Error('write after end')))
      return false
    }
    this.chunks += 1
    for (const { atChunk, event } of MOCK_SEQUENCE) {
      if (atChunk !== this.chunks) continue
      // Wrap in setImmediate so the write() call returns first — real
      // gRPC streams deliver `data` asynchronously.
      setImmediate(() => {
        this.emit('data', {
          results: [{
            alternatives: [{ transcript: event.text }],
            isFinal: event.isFinal
          }]
        })
      })
    }
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    setImmediate(() => this.emit('end'))
  }

  destroy(): void {
    this.ended = true
    // EventEmitter doesn't have a `destroyed` state by default; the
    // real stream would clean up its internals. We just stop
    // responding to writes.
  }
}

// ─── Voxtral Realtime path (Phase 5) ───────────────────────────────────
//
// Wraps Mistral's @mistralai/mistralai/extra/realtime SDK in the same
// `SpeechClientLike` / `SpeechStream` shape the dictate handler already
// consumes. The SDK takes an `AsyncGenerator<Uint8Array>` and yields
// transcription events; we bridge that to the EventEmitter contract via
// a small internal queue.
//
// Audio format match: Voxtral expects PCM s16le, 16-bit mono, 16 kHz —
// the exact format our AudioWorklet pipeline produces. No client-side
// codec change. The pre-Phase-5 (Cloud STT) MP4/AAC rejection (Safari
// quirk) may disappear under Voxtral — verify in a future safari pass.

export function createDictateRealtimeClient(apiKey: string): SpeechClientLike {
  if (process.env.TEST_MODE === '1' && (
    process.env.NUXT_VOXTRAL_REALTIME_MOCK === '1'
    || process.env.NUXT_GOOGLE_SPEECH_MOCK === '1'
  )) {
    return new MockRealtimeClient()
  }
  return new VoxtralRealtimeClient(apiKey)
}

class VoxtralRealtimeClient implements SpeechClientLike {
  constructor(private apiKey: string) {}

  streamingRecognize(req: StreamingRecognizeRequest): SpeechStream {
    return new VoxtralRealtimeStream(this.apiKey, req)
  }
}

/**
 * Bridges between (a) the EventEmitter `SpeechStream` interface
 * `dictate.ts` consumes and (b) Mistral's SDK `transcribeStream` which
 * pulls from an `AsyncGenerator<Uint8Array>` and yields events on a
 * different async iterator.
 *
 * Implementation: an internal `chunkQueue` holds incoming audio buffers
 * + a "done" sentinel. The async-generator passed to the SDK pulls
 * from the queue. The SDK's event iterator pumps via a background async
 * task that emits `data` / `error` / `end` events on this stream.
 */
class VoxtralRealtimeStream extends EventEmitter implements SpeechStream {
  private chunkQueue: Array<Uint8Array | null> = []
  private waiters: Array<(value: Uint8Array | null) => void> = []
  private ended = false
  private aborted = false
  private finalText = ''
  private partialText = ''

  constructor(apiKey: string, req: StreamingRecognizeRequest) {
    super()
    void this.run(apiKey, req)
  }

  private nextChunk(): Promise<Uint8Array | null> {
    if (this.chunkQueue.length > 0) {
      const c = this.chunkQueue.shift()!
      return Promise.resolve(c)
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }

  private async* audioGenerator(): AsyncGenerator<Uint8Array, void, unknown> {
    while (!this.aborted) {
      const chunk = await this.nextChunk()
      if (chunk === null) return
      yield chunk
    }
  }

  private async run(apiKey: string, req: StreamingRecognizeRequest): Promise<void> {
    try {
      const client = new RealtimeTranscription({ apiKey })
      // Voxtral's batch transcribe model id, in realtime variant. Using
      // the purpose-built realtime-transcribe (not generic realtime
      // chat) — same logic as Phase 2: dedicated transcription beats
      // a generative chat model for our voice-prompt input flow.
      const model = 'voxtral-mini-transcribe-realtime-2602'
      const audioFormat = {
        encoding: AudioEncoding.PcmS16le,
        sampleRate: req.config.sampleRateHertz
      }

      for await (const event of client.transcribeStream(
        this.audioGenerator(),
        model,
        { audioFormat }
      )) {
        if (this.aborted) return
        if (event.type === 'transcription.text.delta') {
          // Append delta and emit a partial frame. The `text` field
          // here is just the delta — accumulate locally to expose the
          // full running partial (matching the contract pre-Phase-5
          // Cloud STT clients expected).
          // The Mistral SDK's stream union (`TranscriptionStreamTextDelta
          // | UnknownRealtimeEvent`) doesn't narrow to the delta type
          // off `event.type` alone; cast at the access point.
          this.partialText += (event as { text?: string }).text ?? ''
          this.emit('data', {
            results: [{
              alternatives: [{ transcript: this.partialText }],
              isFinal: false
            }]
          })
        } else if (event.type === 'transcription.done') {
          // Emit a final frame with whatever we accumulated, then
          // reset the partial buffer so the next utterance starts
          // fresh. Voxtral's per-utterance done event is what
          // `commitDictationFinal` listens to.
          this.finalText = this.partialText.trim()
          if (this.finalText.length > 0) {
            this.emit('data', {
              results: [{
                alternatives: [{ transcript: this.finalText }],
                isFinal: true
              }]
            })
          }
          this.partialText = ''
          this.finalText = ''
        } else if (event.type === 'error') {
          const errMessage = typeof event.error?.message === 'string'
            ? event.error.message
            : JSON.stringify(event.error?.message ?? 'transcription error')
          this.emit('error', new Error(errMessage))
          return
        }
      }
      // SDK iterator exhausted normally → graceful end.
      this.emit('end')
    } catch (e) {
      if (!this.aborted) this.emit('error', e)
    }
  }

  write(chunk: Buffer): boolean {
    if (this.ended) {
      // Mirror the historical Cloud STT contract: writing after end
      // emits "write after end" so the existing straggler-chunk guard
      // works unchanged.
      queueMicrotask(() => this.emit('error', new Error('write after end')))
      return false
    }
    const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!
      w(u8)
    } else {
      this.chunkQueue.push(u8)
    }
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    // Push a null sentinel to close the audio generator cleanly.
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!
      w(null)
    } else {
      this.chunkQueue.push(null)
    }
  }

  destroy(): void {
    this.aborted = true
    this.ended = true
    while (this.waiters.length > 0) this.waiters.shift()!(null)
    this.chunkQueue.length = 0
  }
}

// ─── Mock for tests (mirrors MockSpeechClient pattern) ─────────────────
class MockRealtimeClient implements SpeechClientLike {
  streamingRecognize(_req: StreamingRecognizeRequest): SpeechStream {
    // Reuse MockSpeechStream — same emission shape works for the
    // realtime path because we converge to the same wire frames
    // (`{type:'partial' | 'final', text}`) for the WS client.
    return new MockSpeechStream()
  }
}
