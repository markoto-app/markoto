import * as Y from 'yjs'

// Comment threads live outside the text, in the top-level Y.Array
// "comments" (see `commentTools.ts`); each thread's `anchorStart` /
// `anchorEnd` are base64-encoded Y.RelativePositions into the text. A move
// deletes and re-inserts the moved text, which turns every relative
// position inside it into a pointer at the deletion point. These helpers
// collect the threads anchored inside a range before the move and write
// fresh anchors at the same offsets of the re-inserted copy, inside the
// caller's transaction.

/** A thread anchored inside a moved range, with its offsets relative to the range start. */
export interface RangeAnchor {
  thread: Y.Map<unknown>
  start: number
  end: number
}

function decode(b64: unknown): Y.RelativePosition | null {
  if (typeof b64 !== 'string' || b64 === '') return null
  try {
    return Y.decodeRelativePosition(new Uint8Array(Buffer.from(b64, 'base64')))
  } catch {
    return null
  }
}

function encode(rel: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(rel)).toString('base64')
}

/** Threads whose whole anchor lies in [from, to), with offsets relative to `from`. */
export function commentAnchorsInRange(ydoc: Y.Doc, from: number, to: number): RangeAnchor[] {
  const out: RangeAnchor[] = []
  for (const thread of ydoc.getArray<Y.Map<unknown>>('comments').toArray()) {
    if (!(thread instanceof Y.Map)) continue
    const startRel = decode(thread.get('anchorStart'))
    const endRel = decode(thread.get('anchorEnd'))
    if (!startRel || !endRel) continue
    const start = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)?.index
    const end = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)?.index
    if (start === undefined || end === undefined || start >= end) continue
    if (start >= from && end <= to) out.push({ thread, start: start - from, end: end - from })
  }
  return out
}

/**
 * Point the collected threads at the same offsets from `base` (the start of
 * the re-inserted copy). Call inside the transaction that made the move,
 * after the insert. Same associations as `create_comment` and the editor:
 * the start sticks to the character after it, the end to the one before.
 */
export function reanchorComments(ytext: Y.Text, anchors: readonly RangeAnchor[], base: number): void {
  for (const a of anchors) {
    a.thread.set('anchorStart', encode(Y.createRelativePositionFromTypeIndex(ytext, base + a.start, 0)))
    a.thread.set('anchorEnd', encode(Y.createRelativePositionFromTypeIndex(ytext, base + a.end, -1)))
  }
}
