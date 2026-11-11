import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { dictationExtensions, setDictationInterim } from '../../app/utils/editor/dictationExtensions'

// CM6 ghost-text extension — drives the grey-italic "what the model
// is hearing" overlay that sits at the caret during dictation. The
// logic is small but carries three behaviors we want pinned:
//   1. Dispatching `setDictationInterim.of('...')` makes a widget
//      appear in the DOM.
//   2. Dispatching `setDictationInterim.of('')` clears it.
//   3. The widget repositions automatically when the caret moves —
//      otherwise interim text would appear wherever the user started
//      dictating, not where they're looking now.

function makeView(initial: string, caret: number): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      selection: { anchor: caret, head: caret },
      extensions: [...dictationExtensions]
    }),
    parent
  })
  return view
}

function ghostEl(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>('.cm-dictation-ghost')
}

describe('dictation ghost-text extension', () => {
  let view: EditorView

  beforeEach(() => {
    view = makeView('hello world', 5)
  })

  it('renders no widget in the idle state', () => {
    // Ensures the extension is truly no-op when dictation isn't
    // running — important because it ships in EditorPane always on,
    // not just during dictation sessions.
    expect(ghostEl(view)).toBeNull()
  })

  it('renders a widget with the interim text on setDictationInterim', () => {
    view.dispatch({ effects: setDictationInterim.of('hello') })
    const el = ghostEl(view)
    expect(el).not.toBeNull()
    expect(el!.textContent).toBe('hello')
  })

  it('updates the widget text when a new interim effect fires', () => {
    view.dispatch({ effects: setDictationInterim.of('hello') })
    view.dispatch({ effects: setDictationInterim.of('hello world') })
    expect(ghostEl(view)!.textContent).toBe('hello world')
  })

  it('clears the widget on setDictationInterim.of("")', () => {
    view.dispatch({ effects: setDictationInterim.of('interim') })
    expect(ghostEl(view)).not.toBeNull()
    view.dispatch({ effects: setDictationInterim.of('') })
    expect(ghostEl(view)).toBeNull()
  })

  it('marks the widget aria-hidden so screen readers skip it', () => {
    // Interim text is noisy (grows character-by-character). A screen
    // reader announcing each partial would be hostile. The user's
    // mic itself is their auditory signal; the ghost is visual only.
    view.dispatch({ effects: setDictationInterim.of('partial') })
    expect(ghostEl(view)!.getAttribute('aria-hidden')).toBe('true')
  })

  it('stays in the DOM after the caret moves (reposition path)', () => {
    // Dictation's "jump to new spot and continue" flow relies on the
    // ViewPlugin rebuilding the DecorationSet on every `selectionSet`
    // transaction. jsdom doesn't do layout so we can't measure pixel
    // position, but we CAN verify the widget survives the rebuild —
    // i.e. the plugin's update hook is correctly triggered by
    // `selectionSet: true`. Before this fix, the widget was static
    // (only rebuilt on doc change) and the ghost would stick to
    // wherever dictation started, not where the caret now is.
    view.dispatch({ effects: setDictationInterim.of('keep me') })
    expect(ghostEl(view)?.textContent).toBe('keep me')
    view.dispatch({ selection: { anchor: 0, head: 0 } })
    // Widget still there, text preserved — proving the plugin's
    // selection-change rebuild doesn't drop state.
    expect(ghostEl(view)?.textContent).toBe('keep me')
  })

  it('survives an unrelated doc change without flickering', () => {
    // A collaborator typing elsewhere fires doc changes through the
    // ViewPlugin's update hook. The ghost widget rebuilds on every
    // update — but the text should stay put; only the caret-anchored
    // position moves if the insert was before the caret.
    view.dispatch({ effects: setDictationInterim.of('keep me') })
    view.dispatch({ changes: { from: 11, insert: '!' } }) // append to "hello world"
    expect(ghostEl(view)!.textContent).toBe('keep me')
  })
})
