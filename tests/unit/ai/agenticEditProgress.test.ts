import { describe, it, expect } from 'vitest'
import {
  EditProgressTracker,
  STALLED_TURN_LIMIT,
  classifyEdit,
  stalledEditNote,
  type EditVerdict,
  type TurnProgress
} from '../../../server/utils/agentic/editProgress'

// The AI loop must not run into its 20-turn limit after finishing the requested edit: the model can keep
// "polishing" (inserting bare newlines, swapping a sentence back and forth, replacing text with itself). These
// tests pin how edits are classified and when a session counts as stalled.

const ok = { isError: false, rejectedNoOp: false, call: 'replace_text:{}' }

describe('classifyEdit', () => {
  it('identical text is no-change', () => {
    expect(classifyEdit('a\nb', 'a\nb', new Set())).toBe('no-change')
  })

  it('only blank lines / spaces changed is whitespace-only', () => {
    expect(classifyEdit('# T\n\nIntro.', '# T\n\n\n\nIntro.', new Set())).toBe('whitespace-only')
    expect(classifyEdit('a b', 'a  b ', new Set())).toBe('whitespace-only')
  })

  it('a changed word is progress', () => {
    expect(classifyEdit('Keep it short.', 'Be concise.', new Set())).toBe('progress')
  })

  it('a separator line is content, not whitespace', () => {
    expect(classifyEdit('Intro.\n', 'Intro.\n\n---\n', new Set())).toBe('progress')
  })
})

describe('EditProgressTracker', () => {
  it('detects a revert to an earlier state of the document', () => {
    const t = new EditProgressTracker('Keep it short.')
    expect(t.noteEdit('Keep it short.', 'Be concise.', ok)).toBe('progress')
    expect(t.noteEdit('Be concise.', 'Keep it short.', ok)).toBe('revert')
  })

  it('the starting text counts as an earlier state', () => {
    const t = new EditProgressTracker('# Welcome\n\nHello.')
    expect(t.noteEdit('# Welcome\n\nHello.', '# Welcome\n\nHi.', ok)).toBe('progress')
    expect(t.noteEdit('# Welcome\n\nHi.', '# Welcome\n\nHello.', ok)).toBe('revert')
  })

  it('a rejected old_str === new_str counts as no-change even without text', () => {
    const t = new EditProgressTracker(null)
    expect(t.noteEdit(null, null, { isError: true, rejectedNoOp: true, call: 'replace_text:{}' })).toBe('no-change')
  })

  it('a failed edit (no match) is not classified the first time', () => {
    const t = new EditProgressTracker('x')
    const failed = { isError: true, rejectedNoOp: false, call: 'replace_text:{"old_str":"y"}' }
    expect(t.noteEdit('x', 'x', failed)).toBeNull()
    expect(t.endTurn()).toEqual({ stalled: false, consecutiveStalledTurns: 0, shouldStop: false })
  })

  it('the identical failed call made again is a repeat', () => {
    // replace_text 'Language: "EnglishDeutsch"' (text from the document context, not the document) 13 times in a row.
    const t = new EditProgressTracker('x')
    const failed = { isError: true, rejectedNoOp: false, call: 'replace_text:{"old_str":"Language"}' }
    expect(t.noteEdit('x', 'x', failed)).toBeNull()
    t.endTurn()
    const stops: boolean[] = []
    for (let i = 0; i < STALLED_TURN_LIMIT; i++) {
      expect(t.noteEdit('x', 'x', failed)).toBe('repeat')
      stops.push(t.endTurn().shouldStop)
    }
    expect(stops).toEqual([false, false, true])
    // A different failing call is a fresh mistake, not a repeat.
    expect(t.noteEdit('x', 'x', { ...failed, call: 'replace_text:{"old_str":"other"}' })).toBeNull()
  })

  it('unreadable text leaves a successful edit unclassified', () => {
    const t = new EditProgressTracker(null)
    expect(t.noteEdit(null, null, ok)).toBeNull()
  })

  it(`stops after ${STALLED_TURN_LIMIT} stalled turns in a row (bare-newline inserts)`, () => {
    // insert_text "\n" at lines 79, 80, 81 … for 17 turns.
    let doc = 'Intro.\n'
    const t = new EditProgressTracker(doc)
    const results: TurnProgress[] = []
    for (let i = 0; i < STALLED_TURN_LIMIT; i++) {
      const before = doc
      doc = doc + '\n'
      expect(t.noteEdit(before, doc, ok)).toBe('whitespace-only')
      results.push(t.endTurn())
    }
    expect(results.map(r => r.shouldStop)).toEqual([false, false, true])
    expect(results.at(-1)?.consecutiveStalledTurns).toBe(STALLED_TURN_LIMIT)
  })

  it('stops a sentence swapped back and forth (Keep it short ↔ Be concise)', () => {
    const states = ['Write short.', 'Keep it short.', 'Be concise.', 'Keep it short.', 'Be concise.', 'Keep it short.']
    const t = new EditProgressTracker(states[0] ?? null)
    const stops: boolean[] = []
    for (let i = 1; i < states.length; i++) {
      t.noteEdit(states[i - 1] ?? null, states[i] ?? null, ok)
      stops.push(t.endTurn().shouldStop)
    }
    // progress, progress, revert, revert, revert → stop on the 3rd revert.
    expect(stops).toEqual([false, false, false, false, true])
  })

  it('a turn with real progress resets the streak', () => {
    const t = new EditProgressTracker('a')
    t.noteEdit('a', 'a\n', ok)
    expect(t.endTurn().consecutiveStalledTurns).toBe(1)
    t.noteEdit('a\n', 'a\nb', ok)
    expect(t.endTurn()).toEqual({ stalled: false, consecutiveStalledTurns: 0, shouldStop: false })
  })

  it('one progressing edit makes the whole turn progress', () => {
    const t = new EditProgressTracker('a')
    t.noteEdit('a', 'a\n', ok)
    t.noteEdit('a\n', 'a\nb', ok)
    expect(t.endTurn().stalled).toBe(false)
  })

  it('turns without edits neither count nor reset', () => {
    const t = new EditProgressTracker('a')
    t.noteEdit('a', 'a\n', ok)
    t.endTurn()
    // view_document turn: no edits recorded.
    expect(t.endTurn()).toEqual({ stalled: false, consecutiveStalledTurns: 1, shouldStop: false })
    t.noteEdit('a\n', 'a\n\n', ok)
    expect(t.endTurn().consecutiveStalledTurns).toBe(2)
  })
})

describe('stalledEditNote', () => {
  it('tells the model how to finish for every stalled verdict', () => {
    const stalledVerdicts: EditVerdict[] = ['no-change', 'whitespace-only', 'revert', 'repeat']
    for (const v of stalledVerdicts) {
      expect(stalledEditNote(v)).toContain('reply without calling any tool')
    }
  })

  it('says nothing for progress', () => {
    expect(stalledEditNote('progress')).toBeNull()
  })
})
