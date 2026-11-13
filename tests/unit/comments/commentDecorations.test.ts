import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  commentDecorationsExtension,
  setCommentRanges,
  setFlashRange,
  type CommentRange
} from '../../../app/utils/comments/commentDecorations'

// Decoration state-field driven by `setCommentRanges` and
// `setFlashRange` effects.
//
// We don't mount a real EditorView for these, the StateField is the
// unit under test, and CM6's `state.update({ effects: ... })` runs the
// field's `update` callback synchronously without needing a DOM. This
// keeps the suite in the unit project (no happy-dom / no Vue).
//
// What we want to lock in:
//   - Initial state is empty.
//   - setCommentRanges creates one mark per valid range, with the
//     comment id on `data-comment-id`.
//   - Replacing the ranges replaces the decoration set wholesale
//     (no leak from the previous list).
//   - Doc edits between dispatches shift existing decorations so
//     the underline tracks the text without manual repositioning.
//   - Malformed ranges (from >= to, negative from) are silently
//     skipped: never throw, never paint.
//   - setFlashRange sets a flash decoration; null clears it.

function makeState(doc = 'hello world') {
  return EditorState.create({
    doc,
    extensions: [commentDecorationsExtension({})]
  })
}

function readDecorations(state: EditorState): Array<{ from: number, to: number, classes: string[], dataCommentId?: string }> {
  // The field for comment marks is the FIRST extension provided by
  // commentDecorationsExtension. CM stores fields by Symbol; iterating
  // via `EditorView.decorations` would need a view. Instead we read
  // every decoration set the state advertises and flatten.
  const out: Array<{ from: number, to: number, classes: string[], dataCommentId?: string }> = []
  for (const facetValue of state.facet(EditorView.decorations) as unknown as Array<((s: EditorState) => unknown) | { iter: () => unknown }>) {
    // A facet value can be a function (lazy) or a DecorationSet directly.
    const set = typeof facetValue === 'function' ? facetValue(state) : facetValue
    if (!set || typeof (set as { iter?: unknown }).iter !== 'function') continue
    const cursor = (set as { iter: () => { value: { spec: { class?: string, attributes?: Record<string, string> } } | null, from: number, to: number, next: () => void } }).iter()
    while (cursor.value) {
      out.push({
        from: cursor.from,
        to: cursor.to,
        classes: (cursor.value.spec.class ?? '').split(/\s+/).filter(Boolean),
        dataCommentId: cursor.value.spec.attributes?.['data-comment-id']
      })
      cursor.next()
    }
  }
  return out
}

function dispatch(state: EditorState, ...effects: Array<ReturnType<typeof setCommentRanges.of> | ReturnType<typeof setFlashRange.of>>) {
  return state.update({ effects }).state
}

function dispatchChanges(state: EditorState, changes: Array<{ from: number, to?: number, insert: string }>) {
  return state.update({ changes }).state
}

describe('comment decorations field', () => {
  it('starts with no decorations', () => {
    const state = makeState()
    expect(readDecorations(state)).toEqual([])
  })

  it('creates one mark per range when setCommentRanges fires', () => {
    let state = makeState('the dog ate the bone')
    const ranges: CommentRange[] = [
      { id: 'c1', from: 4, to: 7 }, // "dog"
      { id: 'c2', from: 16, to: 20 } // "bone"
    ]
    state = dispatch(state, setCommentRanges.of(ranges))
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out).toEqual([
      expect.objectContaining({ from: 4, to: 7, dataCommentId: 'c1' }),
      expect.objectContaining({ from: 16, to: 20, dataCommentId: 'c2' })
    ])
  })

  it('replaces the entire set on every dispatch (no leak)', () => {
    let state = makeState('the dog ate the bone')
    state = dispatch(state, setCommentRanges.of([{ id: 'old', from: 4, to: 7 }]))
    state = dispatch(state, setCommentRanges.of([{ id: 'new', from: 16, to: 20 }]))
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 16, to: 20, dataCommentId: 'new' })
  })

  it('clears all marks when setCommentRanges is fired with an empty list', () => {
    let state = makeState('hello world')
    state = dispatch(state, setCommentRanges.of([{ id: 'x', from: 0, to: 5 }]))
    state = dispatch(state, setCommentRanges.of([]))
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out).toEqual([])
  })

  it('skips ranges where from >= to', () => {
    // A degenerate range can't paint a mark anyway; CM6 throws if you
    // try to add an empty Range. Filtering at the field level keeps
    // the dispatch safe even if upstream fails to filter.
    let state = makeState('hello world')
    state = dispatch(state, setCommentRanges.of([
      { id: 'collapsed', from: 5, to: 5 },
      { id: 'inverted', from: 7, to: 4 },
      { id: 'good', from: 0, to: 5 }
    ]))
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ dataCommentId: 'good' })
  })

  it('skips ranges with a negative from', () => {
    let state = makeState('hello')
    state = dispatch(state, setCommentRanges.of([
      { id: 'bad', from: -1, to: 3 },
      { id: 'good', from: 0, to: 5 }
    ]))
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out.map(d => d.dataCommentId)).toEqual(['good'])
  })

  it('shifts existing decorations across a doc insertion', () => {
    // Insert "PREFIX " at position 0, every existing mark must shift
    // right by 7 chars without us re-dispatching ranges. This is what
    // makes the underline track the text between Y.js anchor refreshes.
    let state = makeState('the dog ate the bone')
    state = dispatch(state, setCommentRanges.of([{ id: 'c1', from: 4, to: 7 }])) // "dog"
    state = dispatchChanges(state, [{ from: 0, insert: 'PREFIX ' }])
    expect(state.doc.toString()).toBe('PREFIX the dog ate the bone')
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    // 4 + 7 = 11 .. 7 + 7 = 14
    expect(out[0]).toMatchObject({ from: 11, to: 14, dataCommentId: 'c1' })
  })

  it('shrinks a decoration when the doc range it covers is partially deleted', () => {
    let state = makeState('the dog ate the bone')
    state = dispatch(state, setCommentRanges.of([{ id: 'c1', from: 4, to: 7 }])) // "dog"
    // Delete "g": anchor's "to" should drop from 7 to 6.
    state = dispatchChanges(state, [{ from: 6, to: 7, insert: '' }])
    const out = readDecorations(state).filter(d => d.classes.includes('cm-comment-anchor'))
    expect(out[0]).toMatchObject({ from: 4, to: 6 })
  })

  it('paints a flash mark on setFlashRange and clears it on null', () => {
    let state = makeState('hello world')
    state = dispatch(state, setFlashRange.of({ from: 0, to: 5 }))
    let flashes = readDecorations(state).filter(d => d.classes.includes('cm-comment-flash'))
    expect(flashes).toEqual([
      expect.objectContaining({ from: 0, to: 5 })
    ])
    state = dispatch(state, setFlashRange.of(null))
    flashes = readDecorations(state).filter(d => d.classes.includes('cm-comment-flash'))
    expect(flashes).toEqual([])
  })

  it('replaces a flash range when a new one is dispatched', () => {
    let state = makeState('the dog ate the bone')
    state = dispatch(state, setFlashRange.of({ from: 0, to: 3 }))
    state = dispatch(state, setFlashRange.of({ from: 4, to: 7 }))
    const flashes = readDecorations(state).filter(d => d.classes.includes('cm-comment-flash'))
    expect(flashes).toHaveLength(1)
    expect(flashes[0]).toMatchObject({ from: 4, to: 7 })
  })

  it('skips a flash range where from >= to', () => {
    let state = makeState('hello')
    state = dispatch(state, setFlashRange.of({ from: 5, to: 5 }))
    const flashes = readDecorations(state).filter(d => d.classes.includes('cm-comment-flash'))
    expect(flashes).toEqual([])
  })

  it('comment marks and flash marks coexist on the same state', () => {
    // The flash sits on top of the anchor underline when the user
    // clicks a thread: the eye picks up both. They must coexist
    // without one stomping the other.
    let state = makeState('the dog ate the bone')
    state = dispatch(state,
      setCommentRanges.of([{ id: 'c1', from: 4, to: 7 }]),
      setFlashRange.of({ from: 4, to: 7 })
    )
    const all = readDecorations(state)
    const anchors = all.filter(d => d.classes.includes('cm-comment-anchor'))
    const flashes = all.filter(d => d.classes.includes('cm-comment-flash'))
    expect(anchors).toHaveLength(1)
    expect(flashes).toHaveLength(1)
  })
})
