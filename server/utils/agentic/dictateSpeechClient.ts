import { EventEmitter } from 'node:events'
import { DEFAULT_REALTIME_MODEL } from '../aiProviders/config'
import {
  AudioEncoding,
  RealtimeTranscription
} from '@mistralai/mistralai/extra/realtime'
import { isTestModeEnabled } from '../../../shared/utils/security/testMode'
import { MISTRAL_EU_API_HOST } from '../../../shared/ai/providers'
import { useEnv } from '~~/shared/env/load'
import { TranscriptSegmenter } from './dictation/transcriptSegmenter'

// Factory for the dictate streaming client. Voxtral realtime is the only
// real path; the mock-streaming fixture lets integration tests drive the
// WS handshake without a real upstream (gated on
// `TEST_MODE=1 + NUXT_VOXTRAL_REALTIME_MOCK=1`).

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
 * The fake stream's canned transcript, shaped like the real service: only
 * append-only text deltas while audio flows (keyed to the chunk count so a
 * test feeds a handful of chunks), and one "done" with the whole text after
 * the input ended. Which parts become `final` is decided by the same
 * `TranscriptSegmenter` the real stream uses.
 */
const MOCK_DELTAS: Array<{ atChunk: number, text: string }> = [
  // Realistic dictation: the voice-dictate flow's screenshots show it.
  { atChunk: 1, text: 'Lena says' },
  { atChunk: 2, text: ' the new templates' },
  { atChunk: 3, text: ' save her about an hour a week.' },
  { atChunk: 5, text: ' The export' },
  { atChunk: 6, text: ' still feels slow on long reports.' }
]

/**
 * How long the fake takes from the end of the input to its "done". The real
 * service needed about 0.3 s for a short clip; the fake is slower than that
 * so a client that stops waiting too early loses the trailing text in tests.
 */
export const MOCK_DONE_DELAY_MS = 600

class MockSpeechStream extends EventEmitter implements SpeechStream {
  private chunks = 0
  private ended = false
  private destroyed = false
  private spoken = ''
  private readonly segmenter = new TranscriptSegmenter((text, isFinal) => emitTranscript(this, text, isFinal))

  write(_chunk: Buffer): boolean {
    if (this.ended) {
      // Mirror the real stream's behavior: writing after end emits an
      // error event with "write after end". Tests for the server's
      // straggler-chunk guard rely on this.
      queueMicrotask(() => this.emit('error', new Error('write after end')))
      return false
    }
    this.chunks += 1
    for (const { atChunk, text } of MOCK_DELTAS) {
      if (atChunk !== this.chunks) continue
      // Wrap in setImmediate so the write() call returns first, the real
      // stream delivers its events asynchronously.
      setImmediate(() => {
        if (this.destroyed) return
        this.spoken += text
        this.segmenter.delta(text)
      })
    }
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    // Nothing was said: the service has nothing to flush.
    const delay = this.chunks === 0 ? 0 : MOCK_DONE_DELAY_MS
    setTimeout(() => {
      if (this.destroyed) return
      this.segmenter.done(this.spoken)
      this.emit('end')
    }, delay)
  }

  destroy(): void {
    this.ended = true
    this.destroyed = true
    this.segmenter.dispose()
  }
}

/** The `data` event shape the relay reads (`upstreamSession.ts`). */
function emitTranscript(stream: EventEmitter, transcript: string, isFinal: boolean): void {
  stream.emit('data', { results: [{ alternatives: [{ transcript }], isFinal }] })
}

// Voxtral Realtime path. Wraps Mistral's
// @mistralai/mistralai/extra/realtime SDK in the same `SpeechClientLike` /
// `SpeechStream` shape the dictate handler already consumes. The SDK takes an `AsyncGenerator<Uint8Array>` and yields
// transcription events; we bridge that to the EventEmitter contract via
// a small internal queue.
//
// Audio format match: Voxtral expects PCM s16le, 16-bit mono, 16 kHz,
// the exact format our AudioWorklet pipeline produces. No client-side
// codec change.

/** Mistral's EU regional endpoint, the default for every platform-paid realtime stream. */
const MISTRAL_EU_SERVER_URL = `https://${MISTRAL_EU_API_HOST}`

/**
 * `apiKey` is the Mistral key that pays for the stream: the user's own
 * (BYOK transcription provider on api.mistral.ai or api.eu.mistral.ai) or
 * the operator's `MISTRAL_API_KEY` when the instance default is a platform
 * alias. `serverURL` is the Mistral server the WebSocket opens against,
 * the EU endpoint unless the user's own key is configured for another host
 * (`liveDictationTarget`). The SDK's own default is the global endpoint,
 * which makes no location commitment, so it is always passed explicitly.
 */
export function createDictateRealtimeClient(apiKey: string, model: string = DEFAULT_REALTIME_MODEL, serverURL: string = MISTRAL_EU_SERVER_URL): SpeechClientLike {
  if (isTestModeEnabled() && useEnv().test.voxtralRealtimeMock) {
    return new MockRealtimeClient()
  }
  return new VoxtralRealtimeClient(apiKey, model, serverURL)
}

class VoxtralRealtimeClient implements SpeechClientLike {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly serverURL: string) {}

  streamingRecognize(req: StreamingRecognizeRequest): SpeechStream {
    const stream = new VoxtralRealtimeStream(this.apiKey, this.model, req, this.serverURL)
    stream.start()
    return stream
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
 * task that emits `data` / `error` / `end` events on this stream. Which
 * part of the running transcript is final is decided by the
 * `TranscriptSegmenter` (the service itself finalises only once, at the end).
 */
class VoxtralRealtimeStream extends EventEmitter implements SpeechStream {
  private readonly chunkQueue: Array<Uint8Array | null> = []
  private readonly waiters: Array<(value: Uint8Array | null) => void> = []
  private readonly apiKey: string
  private readonly model: string
  private readonly serverURL: string
  private readonly req: StreamingRecognizeRequest
  private ended = false
  private aborted = false
  private readonly segmenter = new TranscriptSegmenter((text, isFinal) => emitTranscript(this, text, isFinal))

  constructor(apiKey: string, model: string, req: StreamingRecognizeRequest, serverURL: string) {
    super()
    this.apiKey = apiKey
    this.model = model
    this.req = req
    this.serverURL = serverURL
  }

  /** Spawn the upstream-pump task. Called by the factory immediately after construction so the constructor itself stays synchronous (S7059). */
  start(): void {
    void this.run(this.apiKey, this.req)
  }

  private nextChunk(): Promise<Uint8Array | null> {
    // `null` is a queued value (the end sentinel); `undefined` means empty.
    const queued = this.chunkQueue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
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
      const client = new RealtimeTranscription({ apiKey, serverURL: this.serverURL })
      // The realtime variant of Voxtral's transcribe model: a dedicated
      // transcription model beats a generative chat model for voice prompts.
      const model = this.model
      const audioFormat = {
        encoding: AudioEncoding.PcmS16le,
        sampleRate: req.config.sampleRateHertz
      }
      // The SDK ends the iteration after `transcription.done`, which the
      // service sends once, after the audio input ended.
      for await (const event of client.transcribeStream(this.audioGenerator(), model, { audioFormat })) {
        if (this.aborted) return
        if (event.type === 'transcription.text.delta') {
          // The SDK's stream union doesn't narrow to the delta type off
          // `event.type` alone; cast at the access point.
          this.segmenter.delta((event as { text?: string }).text ?? '')
        } else if (event.type === 'transcription.done') {
          const text = (event as { text?: unknown }).text
          this.segmenter.done(typeof text === 'string' ? text : undefined)
        } else if (event.type === 'error') {
          this.handleErrorEvent(event)
          return
        }
      }
      // Closed without a `done` (the service hung up): what was heard so
      // far still counts. A no-op after a regular `done`.
      this.segmenter.done()
      this.emit('end')
    } catch (e) {
      if (!this.aborted) this.emit('error', e)
    }
  }

  private handleErrorEvent(event: { error?: { message?: unknown } }): void {
    const errMessage = typeof event.error?.message === 'string'
      ? event.error.message
      : JSON.stringify(event.error?.message ?? 'transcription error')
    this.emit('error', new Error(errMessage))
  }

  write(chunk: Buffer): boolean {
    if (this.ended) {
      // Writing after end emits "write after end", which the server's
      // straggler-chunk guard relies on.
      queueMicrotask(() => this.emit('error', new Error('write after end')))
      return false
    }
    const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const waiter = this.waiters.shift()
    if (waiter) waiter(u8)
    else this.chunkQueue.push(u8)
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    // Push a null sentinel to close the audio generator cleanly.
    const waiter = this.waiters.shift()
    if (waiter) waiter(null)
    else this.chunkQueue.push(null)
  }

  destroy(): void {
    this.aborted = true
    this.ended = true
    this.segmenter.dispose()
    for (const waiter of this.waiters.splice(0)) waiter(null)
    this.chunkQueue.length = 0
  }
}

// Mock for tests (mirrors MockSpeechClient pattern).
class MockRealtimeClient implements SpeechClientLike {
  streamingRecognize(_req: StreamingRecognizeRequest): SpeechStream {
    // Reuse MockSpeechStream: same emission shape works for the
    // realtime path because we converge to the same wire frames
    // (`{type:'partial' | 'final', text}`) for the WS client.
    return new MockSpeechStream()
  }
}
