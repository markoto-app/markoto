import { describe, expect, it } from 'vitest'
import {
  clickSelect,
  EMPTY_SELECTION,
  moveFocus,
  pruneSelection,
  selectAll,
  toggleFocused,
  typeaheadMatch
} from '../../../app/utils/explorer/selection'

const keys = ['a', 'b', 'c', 'd', 'e']
const sel = (s: { selected: ReadonlySet<string> }) => [...s.selected].sort()

describe('explorer selection: clicks', () => {
  it('a plain click selects only that item and anchors there', () => {
    const s = clickSelect(clickSelect(EMPTY_SELECTION, keys, 'a'), keys, 'c')
    expect(sel(s)).toEqual(['c'])
    expect(s.anchor).toBe('c')
  })

  it('Ctrl+click toggles and moves the anchor', () => {
    let s = clickSelect(EMPTY_SELECTION, keys, 'a')
    s = clickSelect(s, keys, 'c', { ctrl: true })
    expect(sel(s)).toEqual(['a', 'c'])
    s = clickSelect(s, keys, 'a', { ctrl: true })
    expect(sel(s)).toEqual(['c'])
    expect(s.anchor).toBe('a')
  })

  it('Shift+click selects the range from the anchor, replacing the selection', () => {
    let s = clickSelect(EMPTY_SELECTION, keys, 'b')
    s = clickSelect(s, keys, 'e', { ctrl: true })
    s = clickSelect(s, keys, 'c', { shift: true })
    expect(sel(s)).toEqual(['c', 'd', 'e'])
    expect(s.anchor).toBe('e')
  })

  it('Ctrl+Shift+click adds the range to the selection', () => {
    let s = clickSelect(EMPTY_SELECTION, keys, 'a')
    s = clickSelect(s, keys, 'c', { ctrl: true })
    s = clickSelect(s, keys, 'e', { ctrl: true, shift: true })
    expect(sel(s)).toEqual(['a', 'c', 'd', 'e'])
  })

  it('a range upwards works too', () => {
    let s = clickSelect(EMPTY_SELECTION, keys, 'd')
    s = clickSelect(s, keys, 'b', { shift: true })
    expect(sel(s)).toEqual(['b', 'c', 'd'])
  })
})

describe('explorer selection: keyboard', () => {
  it('arrows move and select, clamped at the ends', () => {
    let s = moveFocus(EMPTY_SELECTION, keys, 1)
    expect(s.focus).toBe('a')
    s = moveFocus(s, keys, -1)
    expect(s.focus).toBe('a')
    s = moveFocus(s, keys, 10)
    expect(sel(s)).toEqual(['e'])
  })

  it('Shift extends from the anchor, Ctrl moves the focus only, Ctrl+Space toggles', () => {
    let s = clickSelect(EMPTY_SELECTION, keys, 'b')
    s = moveFocus(s, keys, 2, { shift: true })
    expect(sel(s)).toEqual(['b', 'c', 'd'])
    s = moveFocus(s, keys, 1, { ctrl: true })
    expect(s.focus).toBe('e')
    expect(sel(s)).toEqual(['b', 'c', 'd'])
    s = toggleFocused(s)
    expect(sel(s)).toEqual(['b', 'c', 'd', 'e'])
  })

  it('Home / End and select all', () => {
    expect(moveFocus(EMPTY_SELECTION, keys, 'end').focus).toBe('e')
    expect(moveFocus(EMPTY_SELECTION, keys, 'home').focus).toBe('a')
    expect(sel(selectAll(EMPTY_SELECTION, keys))).toEqual(keys)
  })

  it('typeahead finds the next name with the prefix, wrapping', () => {
    const labels = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'alpine'], ['d', 'Delta'], ['e', 'Echo']])
    expect(typeaheadMatch(keys, labels, null, 'a')).toBe('a')
    expect(typeaheadMatch(keys, labels, 'a', 'a')).toBe('c')
    expect(typeaheadMatch(keys, labels, 'c', 'a')).toBe('a')
    expect(typeaheadMatch(keys, labels, 'a', 'alp')).toBe('a')
    expect(typeaheadMatch(keys, labels, 'a', 'zz')).toBeNull()
  })
})

describe('explorer selection: refresh', () => {
  it('drops items that are gone and keeps the rest', () => {
    const s = clickSelect(clickSelect(EMPTY_SELECTION, keys, 'b'), keys, 'd', { ctrl: true })
    const pruned = pruneSelection(s, ['a', 'b', 'c'])
    expect(sel(pruned)).toEqual(['b'])
    expect(pruned.focus).toBeNull()
    expect(pruneSelection(pruned, ['a', 'b', 'c'])).toBe(pruned)
  })
})
