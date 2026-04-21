import * as Y from 'yjs'

// Resolve the selection range the client asked us to rewrite. The
// client sends multiple position-identity shapes because concurrent
// editing between "user hits rewrite" and "server applies rewrite" can
// break any single shape:
//
//   1. RelativePosition (preferred) — a yjs-native pointer that
//      survives inserts/deletes elsewhere in the doc. Indices move
//      automatically when other users edit above the selection.
//   2. Raw (from, to) indices — the absolute positions the client saw
//      at submit time. Used as input, validated against current state.
//   3. `selectionText` — the literal substring the client asked to
//      rewrite. Used as the "did the slice still match?" sanity check
//      AND as the basis for a best-effort `indexOf` recovery when
//      positions don't line up anymore.
//
// The resolver walks these in order of reliability and returns the
// final (from, to) span, tagged with which strategy succeeded so
// callers (tests, telemetry) can observe the fallback distribution.
// Ambiguous cases — the selection text isn't there, appears multiple
// times, or positions are out of bounds — return `{ ok: false }` so
// the endpoint can 409 rather than rewrite the wrong range.
//
// Pure function: takes a ydoc + ytext + primitive inputs; no Nuxt,
// no HTTP. Endpoint wraps the result in an H3 error.

export interface ResolveSelectionInput {
  /** The literal substring the client asked to rewrite. */
  selectionText: string
  /** Raw absolute start index the client saw at submit time. */
  selectionFrom: number
  /** Raw absolute end index the client saw at submit time. */
  selectionTo: number
  /** Optional JSON-serialized Y.RelativePosition for the start. */
  relFrom?: unknown
  /** Optional JSON-serialized Y.RelativePosition for the end. */
  relTo?: unknown
}

export type ResolveSelectionVia
  = | 'relative'   // RelativePosition survived concurrent edits
    | 'raw'        // raw indices matched current doc state
    | 'indexOf'    // single indexOf recovery from the selection text

export type ResolveSelectionResult
  = | { ok: true, from: number, to: number, via: ResolveSelectionVia }
    | { ok: false, reason: 'moved' }

/**
 * Try to upgrade raw indices via RelativePosition when the client
 * provided them. Returns the original indices unchanged when rel* are
 * missing, malformed, or don't resolve to a valid in-order range.
 */
function applyRelativeIfValid(
  ydoc: Y.Doc,
  rawFrom: number,
  rawTo: number,
  relFrom: unknown,
  relTo: unknown
): { from: number, to: number, via: 'relative' | 'raw' } {
  if (!relFrom || !relTo) return { from: rawFrom, to: rawTo, via: 'raw' }
  try {
    const rf = Y.createRelativePositionFromJSON(relFrom as Parameters<typeof Y.createRelativePositionFromJSON>[0])
    const rt = Y.createRelativePositionFromJSON(relTo as Parameters<typeof Y.createRelativePositionFromJSON>[0])
    const absFrom = Y.createAbsolutePositionFromRelativePosition(rf, ydoc)
    const absTo = Y.createAbsolutePositionFromRelativePosition(rt, ydoc)
    if (absFrom && absTo && absTo.index > absFrom.index) {
      return { from: absFrom.index, to: absTo.index, via: 'relative' }
    }
  } catch {
    /* fall through to raw */
  }
  return { from: rawFrom, to: rawTo, via: 'raw' }
}

export function resolveSelection(
  ydoc: Y.Doc,
  ytext: Y.Text,
  input: ResolveSelectionInput
): ResolveSelectionResult {
  // Step 1: upgrade to relative-position-derived indices when possible.
  const { from: step1From, to: step1To, via } = applyRelativeIfValid(
    ydoc,
    input.selectionFrom,
    input.selectionTo,
    input.relFrom,
    input.relTo
  )

  // Step 2: bounds check. A tampered client (or a RelativePosition
  // from a wildly different doc state) could produce indices outside
  // current text; slicing would silently succeed and step 3's indexOf
  // fallback could target the wrong range. Refuse early.
  const docText = ytext.toString()
  const docLen = ytext.length
  let from = step1From
  let to = step1To
  if (from < 0 || to > docLen || from >= to) {
    // Out-of-bounds → don't even try the slice check; go straight to
    // the indexOf recovery below. Reset from/to so the later-match
    // branch is the authoritative source.
    return tryIndexOfRecovery(docText, input.selectionText)
  }

  // Step 3: slice sanity. If the substring at [from, to) still matches
  // what the client asked to rewrite, we're safe to apply.
  const currentSlice = docText.slice(from, to)
  if (currentSlice === input.selectionText) {
    return { ok: true, from, to, via }
  }

  // Step 4: best-effort recovery — the selection text is still in the
  // doc at exactly one position. If so, use that span. Otherwise 409.
  return tryIndexOfRecovery(docText, input.selectionText)
}

/**
 * Last-chance recovery: the selection text must appear in the doc
 * exactly once. More than one match means rewriting either span
 * could overwrite the wrong occurrence; zero means the text is gone
 * entirely.
 */
function tryIndexOfRecovery(docText: string, selectionText: string): ResolveSelectionResult {
  if (!selectionText) return { ok: false, reason: 'moved' }
  const first = docText.indexOf(selectionText)
  const last = docText.lastIndexOf(selectionText)
  if (first >= 0 && first === last) {
    return {
      ok: true,
      from: first,
      to: first + selectionText.length,
      via: 'indexOf'
    }
  }
  return { ok: false, reason: 'moved' }
}
