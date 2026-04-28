import { v1 as speech } from '@google-cloud/speech'
import { EventEmitter } from 'node:events'

// Factory for the Cloud Speech-to-Text streaming client. Real behavior
// by default; a fake behind `TEST_MODE=1 + NUXT_GOOGLE_SPEECH_MOCK=1`
// so integration tests can drive the dictation WS end-to-end without
// hitting Google or paying per-minute. The fake emits a canned
// interim → final → interim → final sequence based on audio-chunk
// count so tests can assert on the state machine (partial, final,
// final-after-stop) without real audio.
//
// Why an env flag and not a DI pattern: the handler runs inside Nitro
// which spawns fresh module graphs per request in dev and per worker
// in prod — no clean way to inject a client reference from outside.
// The env flag is read once at request-time, stays out of prod, and
// costs one `if` in the hot path.

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
 * Returns a real SpeechClient backed by the given API key, OR a fake
 * one when the test mock flag is on. Both expose the minimal subset
 * of the SDK surface (`streamingRecognize`) that the dictate handler
 * uses — the fake class satisfies `SpeechClientLike` structurally so
 * the caller can treat them identically.
 */
export function createDictateSpeechClient(apiKey: string): SpeechClientLike {
  if (process.env.TEST_MODE === '1' && process.env.NUXT_GOOGLE_SPEECH_MOCK === '1') {
    return new MockSpeechClient()
  }
  return new speech.SpeechClient({
    apiKey
  } as unknown as ConstructorParameters<typeof speech.SpeechClient>[0]) as unknown as SpeechClientLike
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

class MockSpeechClient implements SpeechClientLike {
  streamingRecognize(_req: StreamingRecognizeRequest): SpeechStream {
    return new MockSpeechStream()
  }
}

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
