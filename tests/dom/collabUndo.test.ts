import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import { editorKeymap } from '~/utils/editor/collabHistory'

// Regression (staging finding N20): in a freshly opened tab, Ctrl+Z after
// a few edits took back the whole loaded document. CodeMirror's own
// history() recorded the transaction that loaded the synced text, and its
// keymap won Ctrl+Z over the document's Y.UndoManager. The editor now has
// no CodeMirror history and binds undo / redo to the UndoManager, which
// only tracks this tab's own edits. Same wiring as EditorPane.vue.

const LOADED = '# Quarterly report\n\nRevenue grew in every region.\n'
// Stands in for the HocuspocusProvider: synced updates carry it as origin.
const PROVIDER_ORIGIN = { name: 'provider' }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function serverUpdate(text: string, base?: Y.Doc): Uint8Array {
  const server = new Y.Doc()
  if (base) Y.applyUpdate(server, Y.encodeStateAsUpdate(base))
  server.getText('content').insert(server.getText('content').length, text)
  return base
    ? Y.encodeStateAsUpdate(server, Y.encodeStateVector(base))
    : Y.encodeStateAsUpdate(server)
}

function openEditor() {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const awareness = new Awareness(ydoc)
  const undoManager = new Y.UndoManager(ytext)
  // Mounted before the first sync, like a freshly opened tab.
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [keymap.of(editorKeymap), yCollab(ytext, awareness, { undoManager })]
    })
  })
  cleanups.push(() => {
    view.destroy()
    awareness.destroy()
    ydoc.destroy()
  })
  return { ydoc, ytext, view, undoManager }
}

function press(view: EditorView, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
  return runScopeHandlers(view, event, 'editor')
}

function type(view: EditorView, text: string) {
  const at = view.state.doc.length
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' })
}

describe('collaborative editor undo', () => {
  it('Ctrl+Z after the load and a few edits stops at the loaded document', () => {
    const { ydoc, ytext, view, undoManager } = openEditor()
    Y.applyUpdate(ydoc, serverUpdate(LOADED), PROVIDER_ORIGIN)
    expect(view.state.doc.toString()).toBe(LOADED)

    type(view, 'Costs fell.')
    undoManager.stopCapturing()
    type(view, ' Margins rose.')
    undoManager.stopCapturing()
    type(view, '\n')
    expect(ytext.toString()).toBe(`${LOADED}Costs fell. Margins rose.\n`)

    // One press more than there are edits.
    for (let i = 0; i < 4; i++) expect(press(view, 'z')).toBe(true)
    expect(ytext.toString()).toBe(LOADED)
    expect(view.state.doc.toString()).toBe(LOADED)

    // Redo (Ctrl+Y) brings the edits back, and only them.
    for (let i = 0; i < 4; i++) press(view, 'y')
    expect(ytext.toString()).toBe(`${LOADED}Costs fell. Margins rose.\n`)
  })

  it('undo leaves a collaborator\'s (or the AI\'s) edits alone', () => {
    const { ydoc, ytext, view, undoManager } = openEditor()
    Y.applyUpdate(ydoc, serverUpdate(LOADED), PROVIDER_ORIGIN)
    type(view, 'Mine.')
    undoManager.stopCapturing()
    Y.applyUpdate(ydoc, serverUpdate('\nTheirs.', ydoc), PROVIDER_ORIGIN)
    expect(ytext.toString()).toBe(`${LOADED}Mine.\nTheirs.`)

    press(view, 'z')
    press(view, 'z')
    expect(ytext.toString()).toBe(`${LOADED}\nTheirs.`)
  })
})
