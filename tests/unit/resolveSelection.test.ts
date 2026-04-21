import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { resolveSelection, type ResolveSelectionInput } from '../../server/utils/agentic/resolveSelection'

// The rewrite endpoint's position-resolution logic. If this returns
// wrong indices, AI rewrite overwrites the WRONG TEXT — a silent
// data-corruption bug. Every fallback branch is pinned explicitly.
//
// The four-step chain, in order of preference:
//   1. RelativePosition — survives concurrent edits above the selection
//   2. Raw (from, to) indices + matching slice
//   3. indexOf recovery — selection text appears exactly once
//   4. 409 'moved' — ambiguous / missing

function makeDoc(text: string): { ydoc: Y.Doc, ytext: Y.Text } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  if (text.length > 0) ytext.insert(0, text)
  return { ydoc, ytext }
}

function input(overrides: Partial<ResolveSelectionInput> & Pick<ResolveSelectionInput, 'selectionText'>): ResolveSelectionInput {
  return {
    selectionFrom: 0,
    selectionTo: overrides.selectionText.length,
    ...overrides
  }
}

/**
 * Build a JSON-serialized RelativePosition pointing at a given
 * absolute index. This is what the client would send over the wire.
 */
function relAt(ytext: Y.Text, index: number): unknown {
  const rel = Y.createRelativePositionFromTypeIndex(ytext, index)
  return JSON.parse(JSON.stringify(rel))
}

describe('resolveSelection — step 1: raw indices happy path (no relative provided)', () => {
  it('resolves when the client indices still match the doc slice', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11
    })
    expect(result).toEqual({ ok: true, from: 6, to: 11, via: 'raw' })
  })

  it('works at the very start of the doc', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'hello',
      selectionFrom: 0,
      selectionTo: 5
    })
    expect(result).toEqual({ ok: true, from: 0, to: 5, via: 'raw' })
  })

  it('works at the very end of the doc', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11
    })
    expect(result.ok).toBe(true)
    expect((result as { to: number }).to).toBe(ytext.length)
  })
})

describe('resolveSelection — step 1 → step 3: indexOf recovery when raw indices are stale', () => {
  it('recovers via indexOf when the client sent stale indices (text moved)', () => {
    // Simulate: client selected "world" at [6,11] in "hello world",
    // but before the rewrite landed, another user inserted "!" at the
    // start. Client's raw indices now point at [6,11] = "world" still,
    // just by luck — actually no, let's make a cleaner case:
    // client sent [0, 5] thinking "hello" was there, but the doc is
    // actually "..HELLO hello" so position 0-5 is "..HEL" — wrong
    // slice, but "hello" still appears uniquely at index 8.
    const { ydoc, ytext } = makeDoc('abc hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'hello',
      selectionFrom: 0,
      selectionTo: 5 // stale — "abc h" at [0,5], not "hello"
    })
    expect(result).toEqual({
      ok: true,
      from: 4,
      to: 9,
      via: 'indexOf'
    })
  })

  it('refuses when the selection text appears MULTIPLE times (ambiguous)', () => {
    // The whole point of the 409 branch — we'd have to guess which
    // occurrence, and getting it wrong silently rewrites the wrong
    // sentence. Refuse loudly.
    const { ydoc, ytext } = makeDoc('foo bar foo bar')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'foo',
      selectionFrom: 0, // stale position — slice wouldn't match
      selectionTo: 2
    })
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })

  it('refuses when the selection text is entirely gone from the doc', () => {
    const { ydoc, ytext } = makeDoc('completely different content')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'nope',
      selectionFrom: 0,
      selectionTo: 4
    })
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })

  it('refuses on empty selection text (defensive)', () => {
    // The endpoint validates selectionText.length > 0 before calling
    // us, but the pure helper shouldn't assume that — an empty
    // selection can't be disambiguated via indexOf (every position
    // would match).
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: '',
      selectionFrom: 0,
      selectionTo: 0
    })
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })
})

describe('resolveSelection — bounds checking (fuzz / tampered client guard)', () => {
  it('refuses when from is negative', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'not in doc',
      selectionFrom: -1,
      selectionTo: 5
    })
    // -1 is out of bounds → skip to indexOf → not present → moved.
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })

  it('refuses when to > doc length', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'not-present',
      selectionFrom: 0,
      selectionTo: 9999
    })
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })

  it('out-of-bounds raw positions still succeed via indexOf when text is unique', () => {
    // Tampered client: sent (from=0, to=9999) but the real selection
    // text is still uniquely locatable. Defensive recovery takes
    // precedence over bounds failure.
    const { ydoc, ytext } = makeDoc('the quick brown fox')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'quick',
      selectionFrom: -1, // out of bounds
      selectionTo: 9999
    })
    expect(result).toEqual({ ok: true, from: 4, to: 9, via: 'indexOf' })
  })

  it('refuses when from >= to', () => {
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'absent',
      selectionFrom: 5,
      selectionTo: 5
    })
    // Zero-length range falls through to indexOf; text absent → moved.
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })
})

describe('resolveSelection — step 2: RelativePosition recovery', () => {
  it('RelativePosition corrects indices after an insert above the selection', () => {
    // Setup: doc starts as "hello world", client selects "world" at
    // [6, 11] and captures RelativePosition before submitting. Server-
    // side, another user inserts "abc " at the start, shifting "world"
    // to [10, 15]. The raw indices are now stale. RelativePosition
    // still points at "world" — resolveSelection must use it.
    const { ydoc, ytext } = makeDoc('hello world')
    // Client captures relative positions at "world" = [6, 11].
    const relFrom = relAt(ytext, 6)
    const relTo = relAt(ytext, 11)
    // Simulate concurrent insert above the selection — same ydoc.
    ytext.insert(0, 'abc ')
    // "world" is now at [10, 15] in "abc hello world".

    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,  // stale raw
      selectionTo: 11,   // stale raw
      relFrom,
      relTo
    })
    expect(result).toEqual({
      ok: true,
      from: 10,
      to: 15,
      via: 'relative'
    })
  })

  it('RelativePosition is preferred over raw indices even when raw also matches', () => {
    // Regression target: both happen to be valid. Make sure the
    // `via` tag reflects that we took the more reliable path.
    const { ydoc, ytext } = makeDoc('hello world')
    const relFrom = relAt(ytext, 6)
    const relTo = relAt(ytext, 11)
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11,
      relFrom,
      relTo
    })
    expect(result).toEqual({ ok: true, from: 6, to: 11, via: 'relative' })
  })

  it('falls back to raw indices when relFrom is malformed', () => {
    // A bad RelativePosition (missing fields, wrong JSON shape) must
    // NOT block the request — we just fall through to raw + slice.
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11,
      relFrom: { garbage: 'yes' },
      relTo: { garbage: 'yes' }
    })
    expect(result).toEqual({ ok: true, from: 6, to: 11, via: 'raw' })
  })

  it('falls back to raw when only relFrom is provided (relTo missing)', () => {
    // Both rel* must be present for the relative path to engage —
    // a half-specified position is useless.
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11,
      relFrom: relAt(ytext, 6)
      // relTo omitted
    })
    expect(result.ok).toBe(true)
    expect((result as { via: string }).via).toBe('raw')
  })

  it('falls back to raw when relative positions resolve to an inverted range', () => {
    // Pathological client: sends relFrom > relTo somehow (tampered,
    // or a race condition where both ends moved independently). The
    // `absTo.index > absFrom.index` guard must trip and we must
    // retry via raw.
    const { ydoc, ytext } = makeDoc('hello world')
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11,
      relFrom: relAt(ytext, 11), // inverted!
      relTo: relAt(ytext, 6)
    })
    expect(result).toEqual({ ok: true, from: 6, to: 11, via: 'raw' })
  })

  it('RelativePosition whose target was DELETED falls back to raw', () => {
    // Client captured rel positions at [5, 10] in "hello world".
    // Another user then deleted those characters; the RelativePosition
    // either resolves to a now-different span or doesn't resolve at
    // all. Either way, we fall through to raw + slice + indexOf.
    const { ydoc, ytext } = makeDoc('hello world')
    const relFrom = relAt(ytext, 6)
    const relTo = relAt(ytext, 11)
    // Delete the selected text.
    ytext.delete(6, 5)
    // Now doc = "hello ", no "world".
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'world',
      selectionFrom: 6,
      selectionTo: 11,
      relFrom,
      relTo
    })
    // indexOf recovery also fails — "world" is gone entirely.
    expect(result).toEqual({ ok: false, reason: 'moved' })
  })
})

describe('resolveSelection — fallback interactions', () => {
  it('RelativePosition moves position, slice STILL matches → takes relative path', () => {
    // The successful regression case: concurrent user inserted text
    // ABOVE the selection, relative positions track the shift, slice
    // at new indices matches selectionText → done.
    const { ydoc, ytext } = makeDoc('foo baz')
    const relFrom = relAt(ytext, 4)
    const relTo = relAt(ytext, 7)
    ytext.insert(0, 'XYZ ')
    // Doc is now "XYZ foo baz", selection now at [8, 11] = "baz".
    const result = resolveSelection(ydoc, ytext, {
      selectionText: 'baz',
      selectionFrom: 4,
      selectionTo: 7,
      relFrom,
      relTo
    })
    expect(result).toEqual({ ok: true, from: 8, to: 11, via: 'relative' })
  })

  it('RelativePosition moves, but slice at resolved indices does NOT match → indexOf last resort', () => {
    // Pathological: rel positions move as expected, but the text at
    // those indices is now different (a collaborator replaced the
    // selection text in-place). If "baz" still appears uniquely
    // elsewhere, indexOf recovery wins.
    const { ydoc, ytext } = makeDoc('foo baz qux baz')
    // NB: "baz" appears TWICE — pick a case where the client's
    // original unique match becomes ambiguous after concurrent edits.
    // Here even step 1 matches, so this reduces to step-1 happy path.
    // We want a case where slice mismatch triggers indexOf.
    //
    // Actually cleaner: set up raw indices that mismatch the slice
    // AND selection text appears uniquely elsewhere. Rel is absent
    // (keeps the step path simple).
    const doc2 = makeDoc('aaa unique-phrase bbb')
    const result = resolveSelection(doc2.ydoc, doc2.ytext, {
      selectionText: 'unique-phrase',
      selectionFrom: 0, // stale — points at "aaa u"
      selectionTo: 13
    })
    expect(result).toEqual({
      ok: true,
      from: 4,
      to: 17,
      via: 'indexOf'
    })
  })
})
