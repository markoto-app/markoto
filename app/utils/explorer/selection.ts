// Explorer selection with the semantics of a desktop file manager, as pure
// functions over the ordered list of visible item keys (unit-tested):
//
//   click            select only this item; it becomes the anchor
//   Ctrl/Cmd+click   toggle this item; it becomes the anchor
//   Shift+click      select the range anchor..item (replacing the selection)
//   Ctrl+Shift+click add the range anchor..item to the selection
//
// Keyboard: arrows move the focus and select it; with Shift they extend the
// range from the anchor; with Ctrl they move the focus only (Ctrl+Space
// toggles the focused item).

export interface SelectionState {
  selected: ReadonlySet<string>
  /** Where a Shift range starts. */
  anchor: string | null
  /** The item with the keyboard focus (the "current" row). */
  focus: string | null
}

export interface Modifiers {
  ctrl?: boolean
  shift?: boolean
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null, focus: null }

function range(keys: readonly string[], a: string | null, b: string): string[] {
  const end = keys.indexOf(b)
  const start = a === null ? end : keys.indexOf(a)
  if (start === -1 || end === -1) return end === -1 ? [] : [b]
  const [lo, hi] = start <= end ? [start, end] : [end, start]
  return keys.slice(lo, hi + 1)
}

export function clickSelect(state: SelectionState, keys: readonly string[], key: string, mods: Modifiers = {}): SelectionState {
  if (mods.shift) {
    const span = range(keys, state.anchor ?? key, key)
    const selected = mods.ctrl ? new Set([...state.selected, ...span]) : new Set(span)
    return { selected, anchor: state.anchor ?? key, focus: key }
  }
  if (mods.ctrl) {
    const selected = new Set(state.selected)
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    return { selected, anchor: key, focus: key }
  }
  return { selected: new Set([key]), anchor: key, focus: key }
}

export type FocusMove = number | 'home' | 'end'

/** Move the focus by `delta` rows (or to the first / last) and select per the modifiers. */
export function moveFocus(state: SelectionState, keys: readonly string[], move: FocusMove, mods: Modifiers = {}): SelectionState {
  if (keys.length === 0) return state
  const current = state.focus === null ? -1 : keys.indexOf(state.focus)
  let next: number
  if (move === 'home') next = 0
  else if (move === 'end') next = keys.length - 1
  else if (current === -1) next = move > 0 ? 0 : keys.length - 1
  else next = Math.min(keys.length - 1, Math.max(0, current + move))
  const key = keys[next] as string
  if (mods.ctrl && !mods.shift) return { ...state, focus: key }
  if (mods.shift) {
    const anchor = state.anchor ?? state.focus ?? key
    return { selected: new Set(range(keys, anchor, key)), anchor, focus: key }
  }
  return { selected: new Set([key]), anchor: key, focus: key }
}

/** Ctrl+Space: toggle the focused item. */
export function toggleFocused(state: SelectionState): SelectionState {
  if (state.focus === null) return state
  return clickSelect(state, [state.focus], state.focus, { ctrl: true })
}

export function selectAll(state: SelectionState, keys: readonly string[]): SelectionState {
  return { selected: new Set(keys), anchor: state.anchor ?? keys[0] ?? null, focus: state.focus ?? keys[0] ?? null }
}

/** Drop keys that are no longer listed (after a refresh), keeping the rest of the state. */
export function pruneSelection(state: SelectionState, keys: readonly string[]): SelectionState {
  const present = new Set(keys)
  const selected = new Set([...state.selected].filter(k => present.has(k)))
  if (selected.size === state.selected.size && (state.focus === null || present.has(state.focus))) return state
  return {
    selected,
    anchor: state.anchor !== null && present.has(state.anchor) ? state.anchor : null,
    focus: state.focus !== null && present.has(state.focus) ? state.focus : null
  }
}

/** Typeahead: the next key after the focus whose label starts with `prefix` (case-insensitive), wrapping. */
export function typeaheadMatch(keys: readonly string[], labels: ReadonlyMap<string, string>, focus: string | null, prefix: string): string | null {
  if (prefix === '' || keys.length === 0) return null
  const p = prefix.toLocaleLowerCase()
  const start = focus === null ? 0 : keys.indexOf(focus) + (prefix.length === 1 ? 1 : 0)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(Math.max(0, start) + i) % keys.length] as string
    if ((labels.get(key) ?? '').toLocaleLowerCase().startsWith(p)) return key
  }
  return null
}
