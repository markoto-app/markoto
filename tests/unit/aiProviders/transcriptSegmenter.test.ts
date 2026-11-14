import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SENTENCE_QUIET_MS,
  TranscriptSegmenter,
  endsSentence,
  splitAtLastSentenceBoundary
} from '../../../server/utils/agentic/dictation/transcriptSegmenter'

// Voxtral Realtime finalises nothing during a session: it sends append-only
// text deltas and one "done" with the whole text after the audio ended. The
// segmenter decides which part of the running text is final on the way, so
// dictated sentences reach the document while the user is still speaking.

function collect(quietMs?: number) {
  const events: Array<[text: string, isFinal: boolean]> = []
  const segmenter = new TranscriptSegmenter((text, isFinal) => events.push([text, isFinal]), quietMs)
  const finals = () => events.filter(e => e[1]).map(e => e[0])
  const partials = () => events.filter(e => !e[1]).map(e => e[0])
  return { segmenter, events, finals, partials }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('splitAtLastSentenceBoundary', () => {
  it('splits after the last sentence that has a successor', () => {
    expect(splitAtLastSentenceBoundary('One. Two! Thr')).toEqual({ complete: 'One. Two! ', rest: 'Thr' })
  })

  it('keeps a sentence without a successor open', () => {
    expect(splitAtLastSentenceBoundary('One sentence.')).toEqual({ complete: '', rest: 'One sentence.' })
    expect(splitAtLastSentenceBoundary('One sentence. ')).toEqual({ complete: '', rest: 'One sentence. ' })
  })

  it('does not split inside a number or a dotted name', () => {
    expect(splitAtLastSentenceBoundary('Version 3.5 of file.txt is').complete).toBe('')
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitAtLastSentenceBoundary('She said "stop." Then').complete).toBe('She said "stop." ')
  })

  it('splits CJK sentences, which have no space after the full stop', () => {
    expect(splitAtLastSentenceBoundary('今日は晴れです。明日')).toEqual({ complete: '今日は晴れです。', rest: '明日' })
  })
})

describe('endsSentence', () => {
  it.each(['Done.', 'Really?', 'Stop!', 'Well…', 'He said "no." ', '終わり。'])('%s', (text) => {
    expect(endsSentence(text)).toBe(true)
  })

  it.each(['Not yet', 'A comma,', 'Version 3'])('not: %s', (text) => {
    expect(endsSentence(text)).toBe(false)
  })
})

describe('TranscriptSegmenter', () => {
  it('shows the growing text as interim until a sentence is complete', () => {
    const { segmenter, events } = collect()
    segmenter.delta('The')
    segmenter.delta(' quarter')
    segmenter.delta('ly')
    expect(events).toEqual([['The', false], ['The quarter', false], ['The quarterly', false]])
  })

  it('finalises a sentence as soon as the next one starts, and keeps only the new tail interim', () => {
    const { segmenter, events } = collect()
    segmenter.delta('It is ready')
    segmenter.delta('.')
    segmenter.delta(' Please')
    expect(events).toEqual([
      ['It is ready', false],
      ['It is ready.', false],
      ['It is ready.', true],
      ['Please', false]
    ])
  })

  it('finalises a finished sentence after the quiet time', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('It is ready.')
    vi.advanceTimersByTime(SENTENCE_QUIET_MS - 1)
    expect(finals()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(finals()).toEqual(['It is ready.'])
  })

  it('a delta inside the quiet time keeps the sentence open (a decimal point is no end)', () => {
    const { segmenter, finals, partials } = collect()
    segmenter.delta('It costs 3.')
    vi.advanceTimersByTime(SENTENCE_QUIET_MS / 2)
    segmenter.delta('50 francs')
    vi.advanceTimersByTime(SENTENCE_QUIET_MS * 2)
    expect(finals()).toEqual([])
    expect(partials().at(-1)).toBe('It costs 3.50 francs')
  })

  it('never finalises an unfinished sentence on silence alone', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('This goes on')
    vi.advanceTimersByTime(60_000)
    expect(finals()).toEqual([])
  })

  it('at the end emits only what is not final yet, although "done" carries the whole session', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('One.')
    segmenter.delta(' Two.')
    segmenter.delta(' Three')
    segmenter.done('One. Two. Three')
    expect(finals()).toEqual(['One.', 'Two.', 'Three'])
  })

  it('takes the end text where it corrects the open tail', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('One.')
    segmenter.delta(' Too')
    segmenter.done('One. Two.')
    expect(finals()).toEqual(['One.', 'Two.'])
  })

  it('does not emit finalised text again when the end text rewords it', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('One.')
    segmenter.delta(' Two')
    segmenter.done('Won. Two')
    expect(finals()).toEqual(['One.', 'Two'])
  })

  it('emits nothing at the end when everything is final already', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('One.')
    vi.advanceTimersByTime(SENTENCE_QUIET_MS)
    segmenter.done('One.')
    segmenter.done()
    expect(finals()).toEqual(['One.'])
  })

  it('finalises the open tail when the stream ends without an end text', () => {
    const { segmenter, finals } = collect()
    segmenter.delta('Cut off mid')
    segmenter.done()
    expect(finals()).toEqual(['Cut off mid'])
  })

  it('is silent after the end and after dispose', () => {
    const a = collect()
    a.segmenter.delta('One.')
    a.segmenter.done('One.')
    a.segmenter.delta(' Late')
    vi.advanceTimersByTime(SENTENCE_QUIET_MS)
    expect(a.events).toEqual([['One.', false], ['One.', true]])

    const b = collect()
    b.segmenter.delta('One.')
    b.segmenter.dispose()
    vi.advanceTimersByTime(SENTENCE_QUIET_MS)
    b.segmenter.done('One.')
    expect(b.finals()).toEqual([])
  })
})
