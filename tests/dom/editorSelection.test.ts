import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { snapshotEditorSelection } from '../../app/utils/editorSelection'
import { EDITOR_SELECTION_TEXT_MAX } from '../../shared/types/editorSelection'

// Client-side snapshot helper. Covers the three states the AI prompt
// bar reports plus the `everFocused` gate that distinguishes "CM6's
// default cursor at position 0" from "user placed the cursor on line 1".

function makeView(text: string, from: number, to: number): EditorView {
  const state = EditorState.create({
    doc: text,
    selection: { anchor: from, head: to }
  })
  return new EditorView({ state })
}

describe('snapshotEditorSelection', () => {
  it('returns kind: none when view is null', () => {
    expect(snapshotEditorSelection(null, true)).toEqual({ kind: 'none' })
  })

  it('returns kind: none when view exists but was never focused', () => {
    // The CM6 default state sits at {from:0,to:0}. Without the
    // everFocused gate this would mis-report "cursor on line 1" for
    // every freshly-opened doc.
    const view = makeView('line one\nline two\nline three', 0, 0)
    expect(snapshotEditorSelection(view, false)).toEqual({ kind: 'none' })
  })

  it('returns kind: cursor with line + column + lineText for an empty selection', () => {
    // Position 9 is inside line 2 ("line two"). Line 2 starts at pos 9
    // (after "line one\n"), so column is 9 - 9 + 1 = 1 and the marker
    // goes at the very start of "line two".
    const view = makeView('line one\nline two\nline three', 9, 9)
    expect(snapshotEditorSelection(view, true)).toEqual({
      kind: 'cursor',
      line: 2,
      column: 1,
      lineText: '<CURSOR_IS_HERE>line two',
      lineTruncated: false
    })
  })

  it('returns kind: cursor on line 1 column 1 when caret is at position 0', () => {
    const view = makeView('hello\nworld', 0, 0)
    expect(snapshotEditorSelection(view, true)).toEqual({
      kind: 'cursor',
      line: 1,
      column: 1,
      lineText: '<CURSOR_IS_HERE>hello',
      lineTruncated: false
    })
  })

  it('splices marker mid-line — the "between two sentences" case', () => {
    // This mirrors the user's canonical example. Line 1 = the sentence
    // pair; caret sits between them.
    const doc = 'This is sentence One. This is sentence Two.'
    const cursorPos = doc.indexOf('This is sentence Two') // caret right before "This is sentence Two"
    const view = makeView(doc, cursorPos, cursorPos)
    const out = snapshotEditorSelection(view, true)
    expect(out).toEqual({
      kind: 'cursor',
      line: 1,
      column: cursorPos + 1,
      lineText: 'This is sentence One. <CURSOR_IS_HERE>This is sentence Two.',
      lineTruncated: false
    })
  })

  it('escapes a pre-existing CURSOR_IS_HERE in the line to avoid ambiguity', () => {
    // Guards against a user who literally typed the marker into their
    // doc, or an attacker trying to confuse the AI about where the
    // real caret is.
    const doc = 'hello <CURSOR_IS_HERE> world'
    const view = makeView(doc, doc.length, doc.length)
    const out = snapshotEditorSelection(view, true)
    if (out.kind !== 'cursor') throw new Error('expected cursor')
    // Only ONE marker in the output — the real one, at the end.
    expect(out.lineText.match(/<CURSOR_IS_HERE>/g)?.length).toBe(1)
    expect(out.lineText.endsWith('<CURSOR_IS_HERE>')).toBe(true)
  })

  it('truncates around the cursor on very long lines and flips lineTruncated', () => {
    const long = 'A'.repeat(500) + 'B'.repeat(500)
    const view = makeView(long, 500, 500)
    const out = snapshotEditorSelection(view, true)
    if (out.kind !== 'cursor') throw new Error('expected cursor')
    expect(out.lineTruncated).toBe(true)
    expect(out.lineText).toContain('<CURSOR_IS_HERE>')
    expect(out.lineText).toContain('…') // window sentinel on at least one side
  })

  it('returns kind: selection with full text when within cap', () => {
    // Select "line two" on line 2.
    const view = makeView('line one\nline two\nline three', 9, 17)
    const out = snapshotEditorSelection(view, true)
    expect(out).toEqual({
      kind: 'selection',
      fromLine: 2,
      toLine: 2,
      text: 'line two',
      truncated: false
    })
  })

  it('truncates long selections with an ellipsis and flips truncated', () => {
    const long = 'A'.repeat(EDITOR_SELECTION_TEXT_MAX + 50)
    const view = makeView(long, 0, long.length)
    const out = snapshotEditorSelection(view, true)
    if (out.kind !== 'selection') throw new Error('expected selection')
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBe(EDITOR_SELECTION_TEXT_MAX + 1) // cap + "…"
    expect(out.text.endsWith('…')).toBe(true)
  })

  it('reports multi-line fromLine / toLine on multi-line selection', () => {
    // Select from mid-line-1 through mid-line-3.
    const view = makeView('line one\nline two\nline three', 5, 22)
    const out = snapshotEditorSelection(view, true)
    if (out.kind !== 'selection') throw new Error('expected selection')
    expect(out.fromLine).toBe(1)
    expect(out.toLine).toBe(3)
  })
})
