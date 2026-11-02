import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { formattingKeymap } from '~/utils/editorCommands'

// The Format menu advertises ⌘B / ⌘I and the welcome document tells new
// users to press Cmd/Ctrl + B / I. These pin that the editor actually
// binds them (EditorPane.vue puts formattingKeymap first, ahead of
// defaultKeymap's own Mod-i = "select parent syntax").

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function makeView(doc: string, from: number, to: number, readOnly = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: from, head: to },
      extensions: [
        keymap.of([...formattingKeymap, ...defaultKeymap]),
        EditorState.readOnly.of(readOnly)
      ]
    })
    // Not attached to the document: happy-dom fires `selectionchange`
    // synchronously when CM6 moves a focused editor's DOM selection,
    // re-entering EditorView.update (browsers fire it async). The
    // keymap + command path under test doesn't need a mounted view.
  })
  views.push(view)
  return view
}

function press(view: EditorView, key: string): boolean {
  // `Mod` resolves to Ctrl outside macOS (happy-dom's platform string).
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, metaKey: false, bubbles: true, cancelable: true })
  return runScopeHandlers(view, event, 'editor')
}

describe('formatting shortcuts', () => {
  it('Mod-b wraps the selection in **bold**', () => {
    const view = makeView('make this bold', 10, 14)
    expect(press(view, 'b')).toBe(true)
    expect(view.state.doc.toString()).toBe('make this **bold**')
  })

  it('Mod-b again removes the bold markers', () => {
    const view = makeView('make this bold', 10, 14)
    press(view, 'b')
    press(view, 'b')
    expect(view.state.doc.toString()).toBe('make this bold')
  })

  it('Mod-i wraps the selection in *italic* (wins over select-parent-syntax)', () => {
    const view = makeView('an aside', 3, 8)
    expect(press(view, 'i')).toBe(true)
    expect(view.state.doc.toString()).toBe('an *aside*')
  })

  it('does nothing in a read-only editor', () => {
    const view = makeView('read only', 0, 4, true)
    press(view, 'b')
    expect(view.state.doc.toString()).toBe('read only')
  })
})
