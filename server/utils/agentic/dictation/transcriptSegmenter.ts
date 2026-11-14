// Turns the upstream's running transcript into committed sentences plus a
// still-open tail.
//
// Voxtral Realtime sends append-only `transcription.text.delta` events for
// the whole session and exactly ONE `transcription.done` (the full text)
// after the audio input ends. It sends nothing at a pause and no segment
// events (measured against the EU endpoint: two sentences with a 3 s pause
// gave 18 deltas, then one done 0.3 s after the input ended). Left as is,
// a ten-minute dictation would stay provisional until the user stops, and
// a closed tab would lose all of it. So the relay finalises as it goes:
//
//   - A sentence is final as soon as the next one starts (sentence-ending
//     punctuation followed by whitespace and more text).
//   - A tail that ends a sentence is final once no delta followed it for
//     `SENTENCE_QUIET_MS`.
//   - Anything else stays the interim tail until one of the rules applies
//     or the stream ends.
//
// Deltas only ever append, so text that was finalised is never revised.
// The end-of-stream text repeats the whole session; only what lies behind
// the finalised part is emitted then.

/**
 * How long a finished sentence waits for more text before it is final.
 * Deltas inside fluent speech arrive at most about half a second apart, so
 * one second without any means the speaker paused; a decimal point or an
 * abbreviation in mid-sentence is followed by its next token well within it.
 */
export const SENTENCE_QUIET_MS = 1_000

const CLOSERS = '["\'’”»)\\]」』]*'
/** The end of a sentence that has a successor: Latin punctuation needs whitespace before the next text ("3.5" is no boundary), CJK punctuation does not. */
const BOUNDARY = new RegExp(`(?:[.!?…]${CLOSERS}\\s+|[。！？]${CLOSERS})(?=\\S)`, 'gu')
const ENDS_SENTENCE = new RegExp(`[.!?…。！？]${CLOSERS}\\s*$`, 'u')

/** Splits `text` after its last sentence that is followed by more text. */
export function splitAtLastSentenceBoundary(text: string): { complete: string, rest: string } {
  let end = 0
  for (const match of text.matchAll(BOUNDARY)) end = match.index + match[0].length
  return { complete: text.slice(0, end), rest: text.slice(end) }
}

export function endsSentence(text: string): boolean {
  return ENDS_SENTENCE.test(text)
}

export class TranscriptSegmenter {
  /** Every delta of the session, in order. */
  private all = ''
  /** Offset in `all` behind which nothing is finalised yet. */
  private openFrom = 0
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(
    private readonly emit: (text: string, isFinal: boolean) => void,
    private readonly quietMs: number = SENTENCE_QUIET_MS
  ) {}

  /** One append-only piece of transcript from the upstream. */
  delta(text: string): void {
    if (this.closed || !text) return
    this.clearQuietTimer()
    this.all += text

    const { complete } = splitAtLastSentenceBoundary(this.all.slice(this.openFrom))
    if (complete) this.finalise(this.openFrom + complete.length)

    const tail = this.all.slice(this.openFrom)
    if (!tail.trim()) return
    this.emit(tail.trim(), false)
    if (endsSentence(tail)) {
      this.quietTimer = setTimeout(() => this.finalise(this.all.length), this.quietMs)
    }
  }

  /**
   * The stream ended. `fullText` is the upstream's transcript of the whole
   * session; the part behind what is already final is emitted. When it does
   * not continue the finalised text (the upstream reworded it), the tail of
   * the deltas is used, so finalised text is never emitted twice.
   */
  done(fullText?: string): void {
    if (this.closed) return
    this.clearQuietTimer()
    const finalised = this.all.slice(0, this.openFrom)
    const tail = fullText?.startsWith(finalised)
      ? fullText.slice(finalised.length)
      : this.all.slice(this.openFrom)
    this.openFrom = this.all.length
    this.closed = true
    if (tail.trim()) this.emit(tail.trim(), true)
  }

  /** Stop without emitting (the session was torn down). */
  dispose(): void {
    this.closed = true
    this.clearQuietTimer()
  }

  private finalise(upTo: number): void {
    const text = this.all.slice(this.openFrom, upTo).trim()
    this.openFrom = upTo
    if (text) this.emit(text, true)
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = undefined
  }
}
