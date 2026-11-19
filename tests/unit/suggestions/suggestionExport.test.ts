import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { toCriticMarkup } from '../../../shared/utils/suggestions/criticMarkup'
import { readSuggestions, suggestionsMap } from '../../../shared/utils/suggestions/ySuggestions'
import { changedRuns, editText, SuggestionLimitError, type SuggestSink } from '../../../server/utils/ai/tools/textWrite'
import { SUGGESTIONS_PER_DOC_MAX } from '../../../shared/utils/suggestions/record'

describe('toCriticMarkup', () => {
  it('marks insertions, deletions and replacements', () => {
    const text = 'The colour of the sky is blue.'
    expect(toCriticMarkup(text, [
      { from: 4, to: 10, text: 'color' },
      { from: 18, to: 18, text: 'clear ' },
      { from: 25, to: 29, text: '' }
    ])).toBe('The {~~colour~>color~~} of the {++clear ++}sky is {--blue--}.')
  })

  it('leaves the text alone without suggestions and never nests overlapping ones', () => {
    expect(toCriticMarkup('plain', [])).toBe('plain')
    const out = toCriticMarkup('alpha beta', [{ from: 0, to: 10, text: '' }, { from: 6, to: 10, text: 'gamma' }])
    expect(out).toBe('{--alpha --}{~~beta~>gamma~~}')
  })
})

function sink(): SuggestSink {
  return { principal: 'ai:assistant:s1', name: 'markoto', forced: false, written: 0 }
}

function doc(text: string): Y.Doc {
  const d = new Y.Doc()
  d.getText('content').insert(0, text)
  return d
}

describe('AI edits in suggestion mode (editText)', () => {
  it('edits the text directly without a sink', () => {
    const d = doc('one two three')
    const r = editText({ ydoc: d, ytext: d.getText('content') }, 'ai:assistant:s1', t => t.insert(3, ' and a half'))
    expect(r.suggested).toBeNull()
    expect(d.getText('content').toString()).toBe('one and a half two three')
  })

  it('turns the same edit into suggestions and leaves the text unchanged', () => {
    const d = doc('The quick brown fox jumps.')
    const s = sink()
    const r = editText({ ydoc: d, ytext: d.getText('content'), suggestSink: s }, 'ai:assistant:s1', (t) => {
      t.delete(4, 5)
      t.insert(4, 'slow')
    })
    expect(r.suggested).toBe(1)
    expect(s.written).toBe(1)
    expect(d.getText('content').toString()).toBe('The quick brown fox jumps.')
    const [only] = readSuggestions(d)
    expect(only?.record).toMatchObject({ text: 'slow', deleted: 'quick', authorPrincipal: 'ai:assistant:s1', authorId: null })
  })

  it('splits a rewrite into one suggestion per changed run of words', () => {
    const d = doc('alpha beta gamma delta epsilon')
    editText({ ydoc: d, ytext: d.getText('content'), suggestSink: sink() }, 'o', (t) => {
      t.delete(0, t.length)
      t.insert(0, 'alpha BETA gamma delta EPSILON')
    })
    expect(readSuggestions(d).map(s => [s.record.deleted, s.record.text])).toEqual([['beta', 'BETA'], ['epsilon', 'EPSILON']])
  })

  it('a no-op edit writes nothing', () => {
    const d = doc('same')
    const r = editText({ ydoc: d, ytext: d.getText('content'), suggestSink: sink() }, 'o', (t) => {
      t.delete(0, 4)
      t.insert(0, 'same')
    })
    expect(r.suggested).toBe(0)
    expect(suggestionsMap(d).size).toBe(0)
  })

  it('refuses past the per-document cap', () => {
    const d = doc('x y')
    const map = suggestionsMap(d)
    for (let i = 0; i < SUGGESTIONS_PER_DOC_MAX; i++) map.set(`k${i}`, {})
    expect(() => editText({ ydoc: d, ytext: d.getText('content'), suggestSink: sink() }, 'o', t => t.insert(0, 'z '))).toThrow(SuggestionLimitError)
  })

  it('changedRuns works on old-text offsets', () => {
    expect(changedRuns('a b c', 'a B c')).toEqual([{ from: 2, to: 3, text: 'B' }])
    expect(changedRuns('same', 'same')).toEqual([])
  })
})

describe('CriticMarkup of empty suggestions', () => {
  it('writes no mark for a suggestion that strikes nothing and inserts nothing', async () => {
    const { toCriticMarkup } = await import('../../../shared/utils/suggestions/criticMarkup')
    expect(toCriticMarkup('abc', [{ from: 1, to: 1, text: '' }])).toBe('abc')
  })
})
