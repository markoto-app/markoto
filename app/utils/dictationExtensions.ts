// `EditorView`, `ViewPlugin`, `Decoration`, and `WidgetType` are RUNTIME
// values (CodeMirror classes used as `extends WidgetType`,
// `Decoration.widget(...)`, `ViewPlugin.fromClass(...)`). The
// `consistent-type-imports` lint rule flips these to `import type {}`
// which silently breaks the build at runtime. The disable is targeted
// — `DecorationSet` IS a type-only and stays inline-tagged.
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

// CodeMirror 6 ghost-text decoration for live dictation. An inline
// widget sits at the caret showing the interim transcript; when
// Voxtral finalises a phrase we commit it to Y.js and clear the
// ghost.
//
// Why a StateField → ViewPlugin pipeline (not just a ViewPlugin):
//   - The interim text comes from OUTSIDE the editor (WebSocket
//     callback on the page). A StateField lets us route updates in
//     via a StateEffect.of(...) dispatch, which then triggers a
//     ViewPlugin update that rebuilds the decoration set. This
//     means the interim text survives unrelated editor updates
//     (e.g. a collaborator typing elsewhere) — if we built the
//     decoration set from a local class field in the ViewPlugin,
//     we'd have to manually re-dispatch on every relevant event.
//
// The widget itself is a tiny `<span>` styled to look like user-agent
// autocomplete suggestions: muted colour, italicised, non-selectable.
// The "listening dot" is a CSS animation declared globally (no
// styled-components overhead).

/**
 * Replace the current dictation ghost text (pass "" to clear).
 */
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
    // Prevent the widget from stealing focus or absorbing keystrokes.
    // aria-hidden because the interim text is read aloud by screen
    // readers via the mic itself (it's the user's own speech).
    wrap.setAttribute('aria-hidden', 'true')
    return wrap
  }

  // Signal to CM6 that clicks, caret motion, etc. should treat this
  // widget as non-interactive. Without this, clicking the ghost
  // positions the caret "inside" it which is visually confusing.
  override ignoreEvent(): boolean { return true }
}

function buildDeco(view: EditorView): DecorationSet {
  const text = view.state.field(dictationState)
  if (!text) return Decoration.none
  const pos = view.state.selection.main.head
  return Decoration.set([
    Decoration.widget({
      widget: new DictationGhostWidget(text),
      // `side: 1` renders after the caret's position instead of
      // displacing it — the caret stays to the left of the ghost.
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
    // Rebuild on doc change (ghost anchored to caret, caret moved),
    // selection change (same reason), or a dictation-state effect.
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

/**
 * Bundle of extensions to include in the editor. Add alongside the
 * existing yCollab / keymap extensions.
 */
export const dictationExtensions = [dictationState, ghostPlugin]

/**
 * Commit a finalized phrase into Y.js at the editor's current caret.
 * Handles the "caret inside a word" edge case by prefixing a space
 * when the immediately-preceding character is a letter / digit — per
 * the UX spec, `fo|o` dictating "bar" becomes `fo bar o`, not
 * `fobaro`. Spaces around punctuation and existing whitespace are
 * left alone.
 *
 * Wrapped in a Y.js transact tagged with a `dictation:{userId}`
 * origin so the activity log and undo stack attribute the write to
 * the user rather than a synthetic principal. Parallels how AI
 * writes use `ai:assistant:{sessionId}`.
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
  const charAfter = caret < view.state.doc.length ? view.state.doc.sliceString(caret, caret + 1) : ' '

  // Leading space if we're mid-word (previous char is word-like and
  // not already whitespace). Trailing space if next char is word-like
  // too — otherwise the next spoken phrase starts glued to the tail
  // of this one.
  const needsLeadSpace = /\w/.test(charBefore)
  const needsTailSpace = /\w/.test(charAfter)
  const insert = (needsLeadSpace ? ' ' : '') + trimmed + (needsTailSpace ? ' ' : ' ')

  const origin = userId !== null ? `dictation:${userId}` : 'dictation:anon'
  ydoc.transact(() => {
    ytext.insert(caret, insert)
  }, origin)

  // Move the caret to the end of the inserted text. yCollab already
  // syncs via Y.js, but CodeMirror doesn't automatically move the
  // local selection — without this, the caret stays at the old
  // position and the NEXT phrase lands in the wrong spot.
  const newPos = caret + insert.length
  view.dispatch({ selection: { anchor: newPos } })
}
