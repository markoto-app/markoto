import { describe, it, expect, beforeEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { commitDictationFinal } from '../../app/utils/editor/dictationExtensions'

// commitDictationFinal is the bridge between Voxtral Realtime's finalized transcript and the Y.js document.
// The logic is small but carries a non-obvious UX choice: if the cursor lands inside a word, we inject
// a leading space so "fo|o" + dictated "bar" yields "fo bar o", not "fobaro". Same for the trailing edge.
//
// yCollab is included in the test so Y.js text inserts flow into the CM6 view's document, exactly as in the
// real editor. Without it, `view.dispatch({ selection: { anchor: newPos } })` would fire outside the doc
// and throw "Selection points outside of document".

function makeViewWithY(ydoc: Y.Doc, ytext: Y.Text, initial: string, caret: number) {
  ytext.insert(0, initial)
  const awareness = new Awareness(ydoc)
  const state = EditorState.create({
    doc: initial,
    selection: { anchor: caret, head: caret },
    extensions: [yCollab(ytext, awareness)]
  })
  return new EditorView({ state })
}

describe('commitDictationFinal', () => {
  let ydoc: Y.Doc
  let ytext: Y.Text
  let capturedOrigin: unknown = null

  beforeEach(() => {
    ydoc = new Y.Doc()
    ytext = ydoc.getText('content')
    capturedOrigin = null
    // Listener is attached per-test AFTER `makeViewWithY` runs, so
    // setup transactions (initial insert, yCollab wiring) don't
    // overwrite the capture. See the origin-assertion tests below.
  })

  function captureOriginFrom(ydoc: Y.Doc) {
    // Y.js's `update` event receives `(update, origin, doc, tr)` and
    // fires synchronously on every committed transaction — the
    // reliable way to read the origin tag. `afterTransaction` also
    // fires but is sometimes swallowed by yCollab's batching, which
    // produced silent false negatives in these assertions.
    ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      capturedOrigin = origin
    })
  }

  it('appends with trailing space at end of empty doc', () => {
    const view = makeViewWithY(ydoc, ytext, '', 0)
    commitDictationFinal(view, ydoc, ytext, 1, 'hello')
    expect(ytext.toString()).toBe('hello ')
  })

  it('injects a leading space when caret is mid-word', () => {
    // Canonical "fo|o" + "bar" → "fo bar o" per the UX spec.
    const view = makeViewWithY(ydoc, ytext, 'foo', 2)
    commitDictationFinal(view, ydoc, ytext, 42, 'bar')
    expect(ytext.toString()).toBe('fo bar o')
  })

  it('does NOT inject a leading space after existing whitespace', () => {
    // Double-spacing would be just as ugly as word-mashing; the
    // helper must detect the preceding whitespace and skip.
    const view = makeViewWithY(ydoc, ytext, 'foo ', 4)
    commitDictationFinal(view, ydoc, ytext, 1, 'bar')
    expect(ytext.toString()).toBe('foo bar ')
  })

  it('does NOT inject a leading space after a newline', () => {
    const view = makeViewWithY(ydoc, ytext, 'foo\n', 4)
    commitDictationFinal(view, ydoc, ytext, 1, 'bar')
    expect(ytext.toString()).toBe('foo\nbar ')
  })

  it('injects trailing space when followed by a word character', () => {
    // Cursor between two words: "foo|bar" + "baz" → "foo baz bar".
    const view = makeViewWithY(ydoc, ytext, 'foobar', 3)
    commitDictationFinal(view, ydoc, ytext, 1, 'baz')
    expect(ytext.toString()).toBe('foo baz bar')
  })

  it('trims whitespace from the transcript before inserting', () => {
    // The transcription upstream sometimes returns a leading/trailing
    // space that would double up with our own spacing logic. Trim
    // first, then pad.
    const view = makeViewWithY(ydoc, ytext, '', 0)
    commitDictationFinal(view, ydoc, ytext, 1, '   hello   ')
    expect(ytext.toString()).toBe('hello ')
  })

  it('is a no-op on empty (after trim) transcripts', () => {
    // A final with only whitespace would leave an awkward lone space
    // hanging in the doc. Skip the commit entirely.
    const view = makeViewWithY(ydoc, ytext, 'existing', 8)
    commitDictationFinal(view, ydoc, ytext, 1, '   ')
    expect(ytext.toString()).toBe('existing')
  })

  it('tags the Y.js transaction with a dictation: origin (user id known)', () => {
    // Origin tagging lets the activity log / undo stack attribute
    // the change to the dictating user rather than a synthetic
    // principal. Mirror of the `ai:assistant:{sessionId}` pattern
    // for AI edits.
    const view = makeViewWithY(ydoc, ytext, '', 0)
    captureOriginFrom(ydoc) // attach AFTER setup so we only see the commit transaction
    commitDictationFinal(view, ydoc, ytext, 42, 'hi')
    expect(capturedOrigin).toBe('dictation:42')
  })

  it('uses a dictation:anon origin when userId is null', () => {
    const view = makeViewWithY(ydoc, ytext, '', 0)
    captureOriginFrom(ydoc)
    commitDictationFinal(view, ydoc, ytext, null, 'hi')
    expect(capturedOrigin).toBe('dictation:anon')
  })

  it('moves the caret to the end of the inserted text', () => {
    // CM6 doesn't auto-advance the caret on a Y.js transact — we
    // dispatch a selection update. Without it, the NEXT commit would
    // land at the old caret position, burying words inside the
    // previously-inserted phrase.
    const view = makeViewWithY(ydoc, ytext, 'pre post', 4)
    commitDictationFinal(view, ydoc, ytext, 1, 'mid')
    expect(ytext.toString()).toBe('pre mid post')
    // Caret lands right after the inserted span (len "mid " = 4).
    expect(view.state.selection.main.head).toBe(4 + 4)
  })
})
