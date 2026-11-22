import { StateEffect } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'

// Lets a panel outside the editor follow its updates (the outline's
// current section follows the cursor) without EditorPane knowing about
// it. One update listener is appended to a view the first time something
// subscribes; it fans out to the current subscribers, so opening and
// closing a panel many times never stacks listeners on the view.

type Listener = (update: ViewUpdate) => void

const hubs = new WeakMap<EditorView, Set<Listener>>()

/** Call `listener` on every update of `view` until the returned function is called. */
export function subscribeViewUpdates(view: EditorView, listener: Listener): () => void {
  let listeners = hubs.get(view)
  if (!listeners) {
    const set = new Set<Listener>()
    listeners = set
    hubs.set(view, set)
    view.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
        for (const l of set) l(update)
      }))
    })
  }
  const own = listeners
  own.add(listener)
  return () => {
    own.delete(listener)
  }
}
