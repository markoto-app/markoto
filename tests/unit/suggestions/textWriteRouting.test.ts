import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { changedRuns, editText, SuggestionLimitError, suggestedNote, writeSuggestions, SETTINGS_NOT_SUGGESTIBLE, type SuggestSink } from '../../../server/utils/ai/tools/textWrite'
import { readSuggestions, suggestionsMap, textWithSuggestions } from '../../../shared/utils/suggestions/ySuggestions'
import { SUGGESTION_TEXT_MAX, SUGGESTIONS_PER_DOC_MAX } from '../../../shared/utils/suggestions/record'

// "Suggest instead of edit": every AI text change goes through editText.
// Without a sink it edits the Y.Text; with one it stores suggestions and
// leaves the text alone.

function setup(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  return { ydoc, ytext }
}
const sink = (over: Partial<SuggestSink> = {}): SuggestSink => ({ principal: 'ai:assistant:s1', name: 'markoto', forced: false, written: 0, ...over })

describe('editText', () => {
  it('edits directly in one transaction with the given origin when there is no sink', () => {
    const { ydoc, ytext } = setup('hello world')
    const origins: unknown[] = []
    ydoc.on('afterTransaction', (t: Y.Transaction) => origins.push(t.origin))
    const r = editText({ ydoc, ytext }, 'ai-origin', t => t.insert(5, ','))
    expect(r).toEqual({ suggested: null })
    expect(ytext.toString()).toBe('hello, world')
    expect(origins).toEqual(['ai-origin'])
  })

  it('records the change as suggestions and leaves the text alone with a sink', () => {
    const { ydoc, ytext } = setup('The quick brown fox')
    const s = sink()
    const r = editText({ ydoc, ytext, suggestSink: s }, 'o', (t) => {
      const i = t.toString().indexOf('quick')
      t.delete(i, 5)
      t.insert(i, 'slow')
    }, 'group-1')
    expect(r.suggested).toBe(1)
    expect(s.written).toBe(1)
    expect(ytext.toString()).toBe('The quick brown fox')
    const [sug] = readSuggestions(ydoc)
    expect(sug!.record).toMatchObject({ text: 'slow', deleted: 'quick', authorId: null, authorPrincipal: 'ai:assistant:s1', authorName: 'markoto', groupId: 'group-1', jobId: null })
    expect(textWithSuggestions(ytext.toString(), [sug!])).toBe('The slow brown fox')
  })

  it('writes nothing when the callback changes nothing', () => {
    const { ydoc, ytext } = setup('same')
    const r = editText({ ydoc, ytext, suggestSink: sink() }, 'o', () => {})
    expect(r.suggested).toBe(0)
    expect(suggestionsMap(ydoc).size).toBe(0)
  })

  it('splits distant changes into one suggestion each, sharing a group', () => {
    const { ydoc, ytext } = setup('alpha beta gamma delta epsilon zeta')
    const r = editText({ ydoc, ytext, suggestSink: sink() }, 'o', (t) => {
      const text = t.toString()
      t.delete(text.indexOf('zeta'), 4)
      t.insert(text.indexOf('zeta'), 'omega')
      t.delete(0, 5)
      t.insert(0, 'ALPHA')
    })
    expect(r.suggested).toBe(2)
    const all = readSuggestions(ydoc)
    expect(all.map(s => s.record.text)).toEqual(['ALPHA', 'omega'])
    expect(new Set(all.map(s => s.record.groupId)).size).toBe(1)
  })

  it('anchors suggestions so a later edit by someone else moves them along', () => {
    const { ydoc, ytext } = setup('one two three')
    editText({ ydoc, ytext, suggestSink: sink() }, 'o', (t) => {
      t.delete(4, 3)
      t.insert(4, '2')
    })
    ytext.insert(0, 'zero ')
    const [s] = readSuggestions(ydoc)
    expect(ytext.toString().slice(s!.from, s!.to)).toBe('two')
  })

  it('clamps out-of-range inserts and deletes of the working copy', () => {
    const { ydoc, ytext } = setup('abc')
    editText({ ydoc, ytext, suggestSink: sink() }, 'o', (t) => {
      t.insert(99, '!')
      t.delete(-5, 1)
      t.delete(1, -3)
      expect(t.length).toBeGreaterThan(0)
      expect(JSON.stringify(t.toJSON())).toContain('!')
    })
    expect(ytext.toString()).toBe('abc')
  })

  it('carries the job id and truncates long names and principals', () => {
    const { ydoc, ytext } = setup('abc def')
    writeSuggestions(ydoc, ytext, [{ from: 0, to: 3, text: 'x' }], sink({ jobId: 'job-9', name: 'n'.repeat(300), principal: `ai-job:${'p'.repeat(300)}` }), 'g'.repeat(200))
    const r = readSuggestions(ydoc)[0]!.record
    expect(r.jobId).toBe('job-9')
    expect(r.authorName).toHaveLength(120)
    expect(r.authorPrincipal).toHaveLength(120)
    expect(r.groupId).toHaveLength(80)
  })

  it('refuses a single change longer than the limit', () => {
    const { ydoc, ytext } = setup('abc')
    const big = 'x'.repeat(SUGGESTION_TEXT_MAX + 1)
    expect(() => writeSuggestions(ydoc, ytext, [{ from: 0, to: 1, text: big }], sink(), 'g')).toThrow(SuggestionLimitError)
    expect(suggestionsMap(ydoc).size).toBe(0)
  })

  it('refuses to open more suggestions than a document may hold', () => {
    const { ydoc, ytext } = setup('abc')
    const map = suggestionsMap(ydoc)
    for (let i = 0; i < SUGGESTIONS_PER_DOC_MAX; i++) map.set(`filler-${i}`, { filler: true })
    const attempt = () => writeSuggestions(ydoc, ytext, [{ from: 0, to: 1, text: 'x' }], sink(), 'g')
    expect(attempt).toThrow(SuggestionLimitError)
    expect(attempt).toThrow(String(SUGGESTIONS_PER_DOC_MAX))
    expect(attempt).toThrow(expect.objectContaining({ reason: 'too-many' }))
  })
})

describe('changedRuns', () => {
  it('is empty for equal texts', () => {
    expect(changedRuns('a b', 'a b')).toEqual([])
  })

  it('widens a changed word to the whole word', () => {
    const [h] = changedRuns('the cat sat', 'the cart sat')
    expect(h).toEqual({ from: 4, to: 7, text: 'cart' })
  })

  it('reports a pure insertion with an empty range', () => {
    const hunks = changedRuns('one three', 'one two three')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.from).toBe(hunks[0]!.to)
    expect(hunks[0]!.text).toContain('two')
  })
})

describe('notes', () => {
  it('pluralises the suggested note and explains an empty result', () => {
    expect(suggestedNote(0)).toContain('nothing changed')
    expect(suggestedNote(1)).toContain('1 suggestion for')
    expect(suggestedNote(3)).toContain('3 suggestions for')
    expect(SETTINGS_NOT_SUGGESTIBLE).toContain('title, theme')
  })
})
