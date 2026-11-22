import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { jumpEditorToLine, topVisibleLine } from '~/utils/editor/outlineJump'
import { subscribeViewUpdates } from '~/utils/editor/viewUpdateHub'

// Outline → editor: a click on a heading puts the cursor at the end of the
// heading's line; the outline follows the editor's updates through one
// shared listener per view.

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function makeView(doc: string): EditorView {
  // Not attached to the document (see editorShortcuts.test.ts).
  const view = new EditorView({ state: EditorState.create({ doc }) })
  views.push(view)
  return view
}

const DOC = '# Title\n\nIntro\n\n## Section\n\nText'

describe('jumpEditorToLine', () => {
  it('puts the cursor at the end of the heading line', () => {
    const view = makeView(DOC)
    const focus = vi.spyOn(view, 'focus').mockImplementation(() => {})
    jumpEditorToLine(view, 4)
    expect(view.state.selection.main.head).toBe(DOC.indexOf('## Section') + '## Section'.length)
    expect(focus).toHaveBeenCalledOnce()
  })

  it('keeps the focus where it is when asked to (a phone)', () => {
    const view = makeView(DOC)
    const focus = vi.spyOn(view, 'focus').mockImplementation(() => {})
    jumpEditorToLine(view, 0, { focus: false })
    expect(view.state.selection.main.head).toBe('# Title'.length)
    expect(focus).not.toHaveBeenCalled()
  })

  it('clamps a line past the end of a document that shrank', () => {
    const view = makeView('one\ntwo')
    vi.spyOn(view, 'focus').mockImplementation(() => {})
    jumpEditorToLine(view, 99)
    expect(view.state.selection.main.head).toBe('one\ntwo'.length)
    jumpEditorToLine(view, -5)
    expect(view.state.selection.main.head).toBe(3)
  })

  it('reads the line at the top of the visible text', () => {
    const view = makeView(DOC)
    expect(topVisibleLine(view)).toBe(0)
  })
})

describe('subscribeViewUpdates', () => {
  it('fans one listener out to every subscriber until they leave', () => {
    const view = makeView('abc')
    const a = vi.fn()
    const b = vi.fn()
    const stopA = subscribeViewUpdates(view, a)
    const stopB = subscribeViewUpdates(view, b)
    view.dispatch({ selection: { anchor: 1 } })
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    stopA()
    a.mockClear()
    b.mockClear()
    view.dispatch({ selection: { anchor: 2 } })
    expect(a).not.toHaveBeenCalled()
    expect(b.mock.calls.at(-1)?.[0].selectionSet).toBe(true)
    stopB()
  })

  it('adds the view listener only once, however often a panel subscribes', () => {
    const view = makeView('abc')
    const dispatch = vi.spyOn(view, 'dispatch')
    for (let i = 0; i < 5; i++) subscribeViewUpdates(view, () => {})()
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
