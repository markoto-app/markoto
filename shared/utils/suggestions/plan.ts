// Turning keystrokes into suggestions (suggesting mode). The editor never
// applies a change while suggesting; it hands each change here and gets
// back the suggestion writes that express it, plus where the caret goes.
//
// Typing continues the author's own suggestion instead of opening a new
// one per keystroke:
//   - typing at the end of your own suggestion appends to its text;
//   - typing at the start of a range you struck makes it a replacement;
//   - Backspace right after your own inserted text removes its last character;
//   - deleting next to (or over) a range you struck extends that range.
// Everything else makes a new suggestion. Pure: offsets in, writes out.

/** One of the author's own open suggestions, resolved to current offsets. */
export interface OwnSuggestion {
  id: string
  from: number
  to: number
  text: string
}

/** One change of an editor transaction, in offsets of the unchanged text. */
export interface SuggestChange {
  from: number
  to: number
  insert: string
}

export type SuggestWrite
  = | { kind: 'create', from: number, to: number, text: string }
    | { kind: 'update', id: string, from: number, to: number, text: string }
    | { kind: 'remove', id: string }

export interface SuggestPlan {
  writes: SuggestWrite[]
  /** Caret offset after the change. */
  cursor: number
}

/** Ids of suggestions still to be created inside a plan (not stored yet). */
const PENDING = 'pending:'

function touches(s: OwnSuggestion, from: number, to: number): boolean {
  return s.from <= to && from <= s.to
}

/**
 * Plan the suggestion writes for the changes of one editor transaction.
 * `backward` is true for Backspace-like deletions (the caret moves left).
 * `own` is the author's open suggestions, most recently changed first.
 */
export function planSuggestion(changes: readonly SuggestChange[], own: readonly OwnSuggestion[], backward: boolean): SuggestPlan {
  const work = own.map(s => ({ ...s }))
  const writes = new Map<string, SuggestWrite>()
  let created = 0
  let cursor = 0

  function put(s: OwnSuggestion) {
    if (s.id.startsWith(PENDING)) writes.set(s.id, { kind: 'create', from: s.from, to: s.to, text: s.text })
    else writes.set(s.id, { kind: 'update', id: s.id, from: s.from, to: s.to, text: s.text })
  }
  function remove(s: OwnSuggestion) {
    work.splice(work.indexOf(s), 1)
    if (s.id.startsWith(PENDING)) writes.delete(s.id)
    else writes.set(s.id, { kind: 'remove', id: s.id })
  }
  function create(from: number, to: number, text: string) {
    const s = { id: `${PENDING}${created++}`, from, to, text }
    work.unshift(s)
    put(s)
  }

  for (const c of changes) {
    if (c.to === c.from && c.insert.length === 0) continue
    if (c.to === c.from) {
      cursor = planInsert(c, work, put, create)
      continue
    }
    if (c.insert.length === 0) {
      cursor = planDelete(c, work, backward, put, remove, create)
      continue
    }
    // Typing over a selection: a replacement of exactly that range.
    const same = work.find(s => s.from === c.from && s.to === c.to)
    if (same) {
      same.text = c.insert
      put(same)
    } else {
      create(c.from, c.to, c.insert)
    }
    cursor = c.to
  }
  return { writes: [...writes.values()], cursor }
}

function planInsert(c: SuggestChange, work: OwnSuggestion[], put: (s: OwnSuggestion) => void, create: (f: number, t: number, x: string) => void): number {
  const atEnd = work.find(s => s.to === c.from)
  if (atEnd) {
    atEnd.text += c.insert
    put(atEnd)
    return atEnd.to
  }
  const atStruckStart = work.find(s => s.from === c.from && s.to > s.from)
  if (atStruckStart) {
    atStruckStart.text += c.insert
    put(atStruckStart)
    return atStruckStart.to
  }
  create(c.from, c.from, c.insert)
  return c.from
}

/** Backspace after your own inserted text: remove its last character (by code point, an emoji is one). */
function trimTyped(c: SuggestChange, work: OwnSuggestion[], put: (s: OwnSuggestion) => void, remove: (s: OwnSuggestion) => void): boolean {
  const typed = work.find(s => s.to === c.to && s.text.length > 0)
  if (!typed) return false
  typed.text = [...typed.text].slice(0, -1).join('')
  if (typed.text.length === 0 && typed.from === typed.to) remove(typed)
  else put(typed)
  return true
}

function planDelete(
  c: SuggestChange,
  work: OwnSuggestion[],
  backward: boolean,
  put: (s: OwnSuggestion) => void,
  remove: (s: OwnSuggestion) => void,
  create: (f: number, t: number, x: string) => void
): number {
  // Backspace right after your own inserted text takes from that text.
  if (backward && trimTyped(c, work, put, remove)) return c.to
  // Already struck by you: nothing changes but the caret.
  if (work.some(s => s.from <= c.from && c.to <= s.to)) return backward ? c.from : c.to
  // Extend your own strike next to it; a replacement only grows at its start
  // (its text stays at its end).
  const pure = work.filter(s => s.text.length === 0 && touches(s, c.from, c.to))
  const replacement = work.find(s => s.text.length > 0 && s.to > s.from && s.from === c.to)
  if (pure.length > 0) {
    const [first, ...rest] = pure as [OwnSuggestion, ...OwnSuggestion[]]
    first.from = Math.min(c.from, ...pure.map(s => s.from))
    first.to = Math.max(c.to, ...pure.map(s => s.to))
    for (const s of rest) remove(s)
    put(first)
  } else if (replacement) {
    replacement.from = c.from
    put(replacement)
  } else {
    create(c.from, c.to, '')
  }
  return backward ? c.from : c.to
}
