import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { closestLineRange, findEditTarget } from '../../../server/utils/ai/tools/textMatch'
import { NO_OP_EDIT_ERROR_PREFIX } from '../../../server/utils/agentic/editProgress'

// replace_text's tiered matching (exact, typographic, trailing whitespace),
// the miss hints (already applied, closest lines) and the line-shift note on
// edit results. Typographic characters are written as escapes so this file
// holds no dash or quote look-alikes.

const LDQ = '\u201C'
const RDQ = '\u201D'
const RSQ = '\u2019'
const EN_DASH = '\u2013'
const EM_DASH = '\u2014'
const NBSP = '\u00A0'
const NNBSP = '\u202F'
const ELLIPSIS = '\u2026'

function makeSession(initial: string): { session: AiSession, ytext: Y.Text } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  if (initial) ytext.insert(0, initial)
  const session = {
    ydoc,
    ytext,
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    provider: null as never,
    sessionId: 's1',
    updateStatus: vi.fn(),
    destroy: async () => {}
  } as unknown as AiSession
  return { session, ytext }
}

async function replace(doc: string, oldStr: string, newStr: string) {
  const { session, ytext } = makeSession(doc)
  const res = await executeFunctionByName(session, 'replace_text', { old_str: oldStr, new_str: newStr })
  return { res, text: ytext.toString() }
}

describe('findEditTarget tiers', () => {
  it('exact match first', () => {
    expect(findEditTarget('a "b" c', '"b"')).toEqual({ kind: 'unique', start: 2, end: 5, tier: 'exact' })
  })

  it('typographic: curly quotes in the document, straight in old_str', () => {
    const doc = `He said ${LDQ}hello${RDQ} and left.`
    const m = findEditTarget(doc, 'said "hello" and')
    expect(m).toMatchObject({ kind: 'unique', tier: 'typographic' })
    if (m.kind !== 'unique') throw new Error('no match')
    expect(doc.slice(m.start, m.end)).toBe(`said ${LDQ}hello${RDQ} and`)
  })

  it('typographic: straight quotes in the document, curly in old_str', () => {
    const doc = 'it\'s "fine"'
    const m = findEditTarget(doc, `it${RSQ}s ${LDQ}fine${RDQ}`)
    expect(m).toMatchObject({ kind: 'unique', start: 0, end: doc.length, tier: 'typographic' })
  })

  it('typographic: dashes, minus, nbsp and narrow nbsp', () => {
    const doc = `10${NBSP}km ${EN_DASH} 20${NNBSP}km ${EM_DASH} \u2212 5`
    const m = findEditTarget(doc, '10 km - 20 km - - 5')
    expect(m).toMatchObject({ kind: 'unique', start: 0, end: doc.length, tier: 'typographic' })
  })

  it('typographic: ellipsis character against three dots, both ways', () => {
    const doc1 = `Wait${ELLIPSIS} then go`
    const m1 = findEditTarget(doc1, 'Wait... then')
    // `Wait\u2026 then`: the original ellipsis is one character.
    expect(m1).toEqual({ kind: 'unique', start: 0, end: 10, tier: 'typographic' })
    const doc2 = 'Wait... then go'
    const m2 = findEditTarget(doc2, `Wait${ELLIPSIS} then`)
    expect(m2).toMatchObject({ kind: 'unique', start: 0, end: 12, tier: 'typographic' })
  })

  it('never matches part of an expanded ellipsis', () => {
    expect(findEditTarget(`a${ELLIPSIS}b`, '..b')).toEqual({ kind: 'none' })
  })

  it('trailing whitespace: spaces at line ends in the document', () => {
    const doc = 'first line   \nsecond line\t\nthird'
    const m = findEditTarget(doc, 'first line\nsecond line\nthird')
    expect(m).toMatchObject({ kind: 'unique', start: 0, end: doc.length, tier: 'trailing-whitespace' })
  })

  it('trailing whitespace: spaces at line ends in old_str, partial first and last line', () => {
    const doc = 'intro: alpha beta\ngamma delta'
    const m = findEditTarget(doc, 'beta  \ngamma')
    // `beta\ngamma` in the document.
    expect(m).toEqual({ kind: 'unique', start: 13, end: 23, tier: 'trailing-whitespace' })
  })

  it('combines typographic and trailing whitespace in the last tier', () => {
    const doc = `${LDQ}Quote${RDQ}  \nnext`
    const m = findEditTarget(doc, '"Quote"\nnext')
    expect(m).toMatchObject({ kind: 'unique', start: 0, end: doc.length, tier: 'trailing-whitespace' })
  })

  it('reports several matches per tier with their lines', () => {
    expect(findEditTarget('x\nfoo\nfoo', 'foo')).toEqual({ kind: 'multiple', count: 2, tier: 'exact', lines: [2, 3] })
    expect(findEditTarget(`${LDQ}a${RDQ}\n${LDQ}a${RDQ}`, '"a"')).toEqual({ kind: 'multiple', count: 2, tier: 'typographic', lines: [1, 2] })
    expect(findEditTarget('a  \nb\na \nb', 'a\nb')).toEqual({ kind: 'multiple', count: 2, tier: 'trailing-whitespace', lines: [1, 3] })
  })

  it('an exact match wins over looser ones elsewhere', () => {
    const doc = `"a" and ${LDQ}a${RDQ}`
    expect(findEditTarget(doc, '"a"')).toEqual({ kind: 'unique', start: 0, end: 3, tier: 'exact' })
  })
})

describe('replace_text with tiered matching', () => {
  it('replaces the document\'s own typographic characters', async () => {
    const { res, text } = await replace(`Er sagte ${LDQ}Hallo${RDQ}.\nEnde`, 'sagte "Hallo".', 'sagte Tschuess.')
    expect(res.isError).toBe(false)
    expect(text).toBe('Er sagte Tschuess.\nEnde')
    expect(res.content).toContain('normalising quotes, dashes and spaces')
  })

  it('maps offsets in front of multi-unit characters correctly', async () => {
    const { res, text } = await replace(`\u{1F600} 1${EN_DASH}2 end`, '1-2', '3-4')
    expect(res.isError).toBe(false)
    expect(text).toBe('\u{1F600} 3-4 end')
  })

  it('replaces across lines with trailing whitespace in the document', async () => {
    const { res, text } = await replace('keep\nalpha  \nbeta\nkeep', 'alpha\nbeta', 'gamma')
    expect(res.isError).toBe(false)
    expect(text).toBe('keep\ngamma\nkeep')
  })

  it('refuses several matches at a loose tier and leaves the document', async () => {
    const doc = `${LDQ}x${RDQ} and ${LDQ}x${RDQ}`
    const { res, text } = await replace(doc, '"x"', 'y')
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Found 2 matches')
    expect(res.content).toContain('normalising')
    expect(text).toBe(doc)
  })

  it('lists the lines of several exact matches', async () => {
    const { res } = await replace('foo\nbar\nfoo', 'foo', 'baz')
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Found 2 matches for old_str, at lines 1, 3')
  })

  it('a loose match whose document text equals new_str is a no-op', async () => {
    const doc = `say ${LDQ}hi${RDQ}`
    const { res, text } = await replace(doc, 'say "hi"', `say ${LDQ}hi${RDQ}`)
    expect(res.isError).toBe(true)
    expect(res.content.startsWith(NO_OP_EDIT_ERROR_PREFIX)).toBe(true)
    expect(text).toBe(doc)
  })
})

describe('replace_text miss hints', () => {
  it('says the edit may already be applied when new_str is present', async () => {
    const { res } = await replace('one\nKlient two\nthree', 'Kunde two', 'Klient two')
    expect(res.isError).toBe(true)
    expect(res.content).toContain('No match found')
    expect(res.content).toContain('may already be applied')
    expect(res.content).toContain('line 2')
    expect(res.content).not.toContain('closest lines')
  })

  it('shows the closest lines, numbered, when old_str drifted', async () => {
    const doc = [
      '# Title',
      '',
      'The quick brown fox jumps over the lazy dog.',
      'It was a sunny day in the valley.',
      '',
      'Unrelated closing words here.'
    ].join('\n')
    const { res } = await replace(doc, 'The quick brown fox leaps over the lazy dog.\nIt was a sunny day in the valley!', 'A new opening sentence.')
    expect(res.isError).toBe(true)
    expect(res.content).toContain('The closest lines in the document:')
    expect(res.content).toContain('3: The quick brown fox jumps over the lazy dog.\n4: It was a sunny day in the valley.')
    expect(res.content).not.toContain('call view_document to see it')
  })

  it('points to a ranged read when nothing is similar', async () => {
    const { res } = await replace('alpha beta', 'zzz yyy', 'x')
    expect(res.isError).toBe(true)
    expect(res.content).toContain('view_range')
    expect(res.content).not.toContain('closest lines')
  })

  it('closest lines are capped at 12', () => {
    const doc = Array.from({ length: 40 }, (_, i) => `line number ${i} with words`).join('\n')
    const needle = Array.from({ length: 30 }, (_, i) => `line number ${i} with wordz`).join('\n')
    const range = closestLineRange(doc, needle)
    expect(range).toEqual({ from: 1, to: 12 })
  })
})

describe('edit results note shifted line numbers', () => {
  it('replace_text that adds lines', async () => {
    const { res } = await replace('a\nb\nc\nd', 'b', 'b1\nb2\nb3')
    expect(res.content).toContain('Line numbers after line 2 shifted by +2; earlier views are out of date below that line.')
  })

  it('replace_text that removes lines', async () => {
    const { res } = await replace('a\nb\nc\nd\ne', 'b\nc\nd\n', '')
    expect(res.content).toContain('Line numbers after line 4 shifted by -3')
  })

  it('no note when the line count stays the same', async () => {
    const { res } = await replace('a\nb\nc', 'b', 'B')
    expect(res.content).not.toContain('shifted')
  })

  it('insert_text in the middle', async () => {
    const { session } = makeSession('# A\n\npara\n\n# B\n\nmore')
    const res = await executeFunctionByName(session, 'insert_text', { insert_line: 3, insert_text: 'added line' })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/Line numbers after line 3 shifted by \+2;/)
  })

  it('no note when appending at the end', async () => {
    const { session } = makeSession('a\nb')
    const res = await executeFunctionByName(session, 'insert_text', { insert_line: 2, insert_text: 'c' })
    expect(res.content).not.toContain('shifted')
  })
})
