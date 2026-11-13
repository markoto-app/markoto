// `EditorView`, `ViewPlugin`, `Decoration` and `WidgetType` are runtime
// values (`extends WidgetType`, `Decoration.widget(...)`,
// `ViewPlugin.fromClass(...)`); the `consistent-type-imports` autofix would
// turn them into type imports and break the build at runtime.
// `DecorationSet` is type-only.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet
} from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type * as Y from 'yjs'

// Ghost-text decoration for live dictation: an inline widget at the caret
// shows the interim transcript; when a phrase is finalised it is committed
// to Y.js and the ghost cleared.
//
// StateField → ViewPlugin rather than a ViewPlugin alone: the interim text
// arrives from outside the editor (a WebSocket callback), and a StateField
// takes it in via a StateEffect dispatch and keeps it across unrelated
// editor updates (e.g. a collaborator typing elsewhere), which a plain
// ViewPlugin field would have to re-dispatch by hand. The widget is a
// muted, italic, non-selectable `<span>`; the "listening dot" is a global
// CSS animation.

/** Replace the current dictation ghost text (pass "" to clear). */
export const setDictationInterim = StateEffect.define<string>()

const dictationState = StateField.define<string>({
  create: () => '',
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setDictationInterim)) return e.value
    }
    return value
  }
})

class DictationGhostWidget extends WidgetType {
  constructor(readonly text: string) { super() }

  override eq(other: DictationGhostWidget): boolean {
    return other.text === this.text
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-dictation-ghost'
    wrap.textContent = this.text
    // aria-hidden: the interim text is the user's own speech, so a screen
    // reader announcing it would be redundant.
    wrap.setAttribute('aria-hidden', 'true')
    return wrap
  }

  // Treat the widget as non-interactive: otherwise clicking the ghost
  // positions the caret "inside" it.
  override ignoreEvent(): boolean { return true }
}

function buildDeco(view: EditorView): DecorationSet {
  const text = view.state.field(dictationState)
  if (!text) return Decoration.none
  const pos = view.state.selection.main.head
  return Decoration.set([
    Decoration.widget({
      widget: new DictationGhostWidget(text),
      // `side: 1` renders after the caret so the caret stays left of the ghost.
      side: 1
    }).range(pos)
  ])
}

const ghostPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = buildDeco(view)
  }

  update(update: { view: EditorView, docChanged: boolean, selectionSet: boolean, transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }) {
    // The ghost is anchored to the caret, so rebuild when the doc or
    // selection changes, or on a dictation-state effect.
    const hadEffect = update.transactions.some(tr =>
      tr.effects.some(e => e.is(setDictationInterim))
    )
    if (update.docChanged || update.selectionSet || hadEffect) {
      this.decorations = buildDeco(update.view)
    }
  }
}, {
  decorations: v => v.decorations
})

/** Extensions to include in the editor alongside yCollab and the keymaps. */
export const dictationExtensions = [dictationState, ghostPlugin]

/**
 * Commit a finalized phrase into Y.js at the editor's current caret.
 * Prefixes a space when the preceding character is a letter / digit, so
 * dictating "bar" at `fo|o` gives `fo bar o`, not `fobaro`. Spaces around
 * punctuation and existing whitespace are left alone.
 *
 * The Y.js transaction carries a `dictation:{userId}` origin so the
 * activity log and undo stack attribute the write to the user, as AI
 * writes do with `ai:assistant:{sessionId}`.
 */
export function commitDictationFinal(
  view: EditorView,
  ydoc: Y.Doc,
  ytext: Y.Text,
  userId: number | null,
  rawText: string
): void {
  const trimmed = rawText.trim()
  if (!trimmed) return

  const caret = view.state.selection.main.head
  const charBefore = caret > 0 ? view.state.doc.sliceString(caret - 1, caret) : ' '

  // Leading space only mid-word. The trailing space is unconditional: the
  // next spoken phrase needs a separator whatever follows, and at EOF
  // there is nothing to collide with. Pinned by
  // tests/dom/dictationCommit.test.ts.
  const needsLeadSpace = /\w/.test(charBefore)
  const insert = (needsLeadSpace ? ' ' : '') + trimmed + ' '

  const origin = userId === null ? 'dictation:anon' : `dictation:${userId}`
  ydoc.transact(() => {
    ytext.insert(caret, insert)
  }, origin)

  // yCollab syncs the text but doesn't move the local selection; without
  // this the NEXT phrase would land at the old caret position.
  const newPos = caret + insert.length
  view.dispatch({ selection: { anchor: newPos } })
}
