import * as Y from 'yjs'
import type { EditorView } from '@codemirror/view'

// Comment anchors built on Y.js relative positions. They're the standard
// Y.js primitive for "this position in the doc, but follow it through
// concurrent edits". When text is inserted above the anchor, the anchor
// shifts down with it; when text inside the anchor is deleted, the anchor
// shrinks; when the surrounding text is removed entirely, the anchor
// resolves to null (orphan).
//
// Each comment stores a `start` + `end` pair, base64-encoded so the value
// JSON-stringifies cleanly.
//
// Sticking conventions (the `assoc` parameter on `createRelativePosition`):
//   - `start`: assoc = 0  (right-bound), text inserted at the very start
//                                          becomes part of the comment.
//   - `end`:   assoc = -1 (left-bound) , text inserted at the very end
//                                          stays OUTSIDE the comment.
// This matches Word/Google-Docs feel: typing between commented chars
// extends the highlight; typing at the boundary doesn't.

export interface SerializedAnchor {
  start: string
  end: string
}

function toBase64(bytes: Uint8Array): string {
  // Chunked because spreading a large buffer into `String.fromCodePoint`
  // overflows the stack; relative positions are tiny, so this is purely
  // defensive. No `Buffer`: this runs in the browser.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0
  return bytes
}

/**
 * The editor's current selection as a serialized relative anchor pair, or
 * null when the selection is empty or out of range.
 */
export function serializeAnchor(
  view: EditorView,
  ytext: Y.Text
): SerializedAnchor | null {
  const sel = view.state.selection.main
  if (sel.empty) return null
  if (sel.from < 0 || sel.to > ytext.length) return null

  const startRel = Y.createRelativePositionFromTypeIndex(ytext, sel.from, 0)
  const endRel = Y.createRelativePositionFromTypeIndex(ytext, sel.to, -1)
  return {
    start: toBase64(Y.encodeRelativePosition(startRel)),
    end: toBase64(Y.encodeRelativePosition(endRel))
  }
}

/**
 * Resolve a stored anchor back to current absolute offsets. Returns null
 * (orphan) when:
 *   - either endpoint can't be decoded (corrupt data),
 *   - either endpoint can't be resolved against the current ydoc, or
 *   - the resolved range collapsed (`from === to`), the text the
 *     comment pointed at has been entirely removed.
 *
 * The collapsed-range check is what catches the common "user deleted the
 * commented text" case: Y.js relative positions tend to gracefully fall
 * back to neighboring positions even when the original item is gone, so
 * a strict null check alone misses most orphans.
 */
export function resolveAnchor(
  anchor: SerializedAnchor,
  ydoc: Y.Doc
): { from: number, to: number } | null {
  let startRel
  let endRel
  try {
    startRel = Y.decodeRelativePosition(fromBase64(anchor.start))
    endRel = Y.decodeRelativePosition(fromBase64(anchor.end))
  } catch {
    return null
  }
  const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
  const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
  if (!startAbs || !endAbs) return null
  if (startAbs.index >= endAbs.index) return null
  return { from: startAbs.index, to: endAbs.index }
}
