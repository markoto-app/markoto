import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import * as Y from 'yjs'
import { serializeAnchor, resolveAnchor } from '../../app/utils/comments/commentAnchors'

// Y.js relative-position round-trip + orphan detection. These guarantees
// are load-bearing for the comments feature:
//   1. After the anchor is created, an insertion ABOVE it shifts the
//      anchor's resolved offset DOWN by exactly the inserted length.
//   2. Insertions INSIDE the anchored range expand the anchor.
//   3. Deleting all anchored chars makes resolveAnchor return null
//      (orphan) — relied on by the sidebar's "Removed from document"
//      section.

function makeView(ytext: Y.Text, from: number, to: number): EditorView {
  const state = EditorState.create({
    doc: ytext.toString(),
    selection: { anchor: from, head: to }
  })
  return new EditorView({ state })
}

describe('commentAnchors', () => {
  it('round-trips a simple selection', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    // Anchor "dog" — chars 4..7
    const view = makeView(ytext, 4, 7)
    const anchor = serializeAnchor(view, ytext)
    expect(anchor).not.toBeNull()
    const resolved = resolveAnchor(anchor!, ydoc)
    expect(resolved).toEqual({ from: 4, to: 7 })
  })

  it('returns null when the selection is empty', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'hello world')
    const view = makeView(ytext, 5, 5) // empty range
    expect(serializeAnchor(view, ytext)).toBeNull()
  })

  it('shifts the anchor when text is inserted above', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    const view = makeView(ytext, 4, 7) // "dog"
    const anchor = serializeAnchor(view, ytext)!

    // Insert 8 chars at position 0.
    ytext.insert(0, 'PREFIX: ')
    expect(ytext.toString()).toBe('PREFIX: the dog ate the bone')

    const resolved = resolveAnchor(anchor, ydoc)
    expect(resolved).toEqual({ from: 12, to: 15 }) // 4+8 .. 7+8
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('dog')
  })

  it('does NOT expand the anchor when text is inserted right at the start', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    const view = makeView(ytext, 4, 7) // "dog"
    const anchor = serializeAnchor(view, ytext)!

    // Insert "BIG " at position 4 — RIGHT at the start. With assoc=0
    // on the start anchor, the start sticks to the original "d" of
    // "dog", which has now moved to position 8. The inserted text
    // stays OUTSIDE the comment range — matches Word/Google-Docs:
    // typing at a comment boundary doesn't extend the comment.
    ytext.insert(4, 'BIG ')
    expect(ytext.toString()).toBe('the BIG dog ate the bone')

    const resolved = resolveAnchor(anchor, ydoc)
    expect(resolved).toEqual({ from: 8, to: 11 })
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('dog')
  })

  it('expands the anchor when text is inserted strictly inside the range', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    const view = makeView(ytext, 4, 7) // "dog"
    const anchor = serializeAnchor(view, ytext)!

    // Insert "ARK" at position 6 — between the "g" and the next char.
    // The end anchor (assoc=-1 sticks to the "g") still tails the new
    // chars, so they fall WITHIN the range.
    ytext.insert(6, 'ARK')
    expect(ytext.toString()).toBe('the doARKg ate the bone')

    const resolved = resolveAnchor(anchor, ydoc)
    expect(resolved).toEqual({ from: 4, to: 10 })
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('doARKg')
  })

  it('does NOT expand the anchor when text is inserted right at the end', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    const view = makeView(ytext, 4, 7) // "dog"
    const anchor = serializeAnchor(view, ytext)!

    // Insert at position 7 — right after "dog". With assoc=-1 on the end
    // anchor, the new chars stay OUTSIDE the range; anchor remains 4..7.
    ytext.insert(7, ' SUFFIX')
    expect(ytext.toString()).toBe('the dog SUFFIX ate the bone')

    const resolved = resolveAnchor(anchor, ydoc)
    expect(resolved).toEqual({ from: 4, to: 7 })
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('dog')
  })

  it('returns null (orphan) when all anchored characters are deleted', () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, 'the dog ate the bone')
    const view = makeView(ytext, 4, 7) // "dog"
    const anchor = serializeAnchor(view, ytext)!

    // Delete "dog ".
    ytext.delete(4, 4)
    expect(ytext.toString()).toBe('the ate the bone')

    expect(resolveAnchor(anchor, ydoc)).toBeNull()
  })

  it('returns null on corrupt input', () => {
    const ydoc = new Y.Doc()
    expect(resolveAnchor({ start: '!!!!', end: '!!!!' }, ydoc)).toBeNull()
  })
})
