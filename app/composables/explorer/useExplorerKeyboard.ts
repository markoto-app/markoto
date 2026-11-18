import type { ExplorerItem } from '~/utils/explorer/model'
import {
  EMPTY_SELECTION,
  moveFocus,
  selectAll,
  toggleFocused,
  typeaheadMatch,
  type FocusMove,
  type SelectionState
} from '~/utils/explorer/selection'

// Keyboard of the explorer list, as in a desktop file manager:
//   arrows / PageUp / PageDown / Home / End move (Shift extends, Ctrl moves
//   the focus only, Ctrl+Space toggles), Enter opens, Backspace or Alt+Up
//   goes to the parent, F2 renames, Delete deletes, Escape clears, Ctrl+A
//   selects all, Ctrl+X / Ctrl+V cut and paste, Ctrl+Z undoes the last move,
//   Alt+N makes a folder, typing jumps to a name.

export interface ExplorerKeyboardDeps {
  selection: Ref<SelectionState>
  keys: Readonly<Ref<string[]>>
  items: Readonly<Ref<ExplorerItem[]>>
  byKey: Readonly<Ref<Map<string, ExplorerItem>>>
  selectedItems: Readonly<Ref<ExplorerItem[]>>
  isRenaming: () => boolean
  canWrite: () => boolean
  focusRow: (key: string | null) => void
  open: (item: ExplorerItem) => void
  goUp: () => void
  rename: (key: string | null) => void
  remove: (items: ExplorerItem[]) => void
  cut: (items: ExplorerItem[]) => void
  paste: () => void
  undo: () => void
  newFolder: () => void
  clearCut: () => void
  /** Any key press: cancels a pending slow-click rename. */
  beforeKey?: () => void
}

const MOVES: Record<string, FocusMove> = {
  ArrowDown: 1,
  ArrowUp: -1,
  PageDown: 10,
  PageUp: -10,
  Home: 'home',
  End: 'end'
}

export function useExplorerKeyboard(d: ExplorerKeyboardDeps) {
  let typeahead = ''
  let typeaheadTimer: ReturnType<typeof setTimeout> | null = null

  function mods(e: KeyboardEvent) {
    return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }
  }

  function focused(): ExplorerItem | undefined {
    const key = d.selection.value.focus
    return key ? d.byKey.value.get(key) : undefined
  }

  /** Arrow-like keys. Returns true when handled. */
  function navigate(e: KeyboardEvent): boolean {
    if (e.key === 'ArrowUp' && e.altKey) {
      d.goUp()
      return true
    }
    const move = MOVES[e.key]
    if (move === undefined) return false
    d.selection.value = moveFocus(d.selection.value, d.keys.value, move, mods(e))
    d.focusRow(d.selection.value.focus)
    return true
  }

  /** Single keys that act on the focus or selection. Returns true when handled. */
  function command(e: KeyboardEvent): boolean {
    const item = focused()
    switch (e.key) {
      case ' ':
        if (!mods(e).ctrl) return false
        d.selection.value = toggleFocused(d.selection.value)
        return true
      case 'Enter':
        if (item) d.open(item)
        return !!item
      case 'Backspace':
        d.goUp()
        return true
      case 'F2':
        d.rename(d.selection.value.focus)
        return true
      case 'Delete':
        d.remove(d.selectedItems.value.length > 0 ? d.selectedItems.value : item ? [item] : [])
        return true
      case 'Escape':
        d.selection.value = { ...EMPTY_SELECTION, focus: d.selection.value.focus }
        d.clearCut()
        return false
      default:
        return false
    }
  }

  /** Ctrl / Cmd shortcuts, and Alt+N (new folder: browsers keep Ctrl+Shift+N for a private window). Returns true when handled. */
  function shortcut(e: KeyboardEvent): boolean {
    if (e.altKey && !mods(e).ctrl && e.code === 'KeyN' && d.canWrite()) {
      d.newFolder()
      return true
    }
    if (!mods(e).ctrl || e.altKey) return false
    const k = e.key.toLowerCase()
    if (k === 'a') d.selection.value = selectAll(d.selection.value, d.keys.value)
    else if (k === 'x') d.cut(d.selectedItems.value)
    else if (k === 'v') d.paste()
    else if (k === 'z') d.undo()
    else return false
    return true
  }

  function jumpTo(e: KeyboardEvent) {
    if (e.key.length !== 1 || e.altKey || mods(e).ctrl || !/\S/.test(e.key)) return
    typeahead += e.key
    if (typeaheadTimer) clearTimeout(typeaheadTimer)
    typeaheadTimer = setTimeout(() => {
      typeahead = ''
    }, 700)
    const labels = new Map(d.items.value.map(i => [i.key, i.label]))
    const hit = typeaheadMatch(d.keys.value, labels, d.selection.value.focus, typeahead)
    if (!hit) return
    d.selection.value = { selected: new Set([hit]), anchor: hit, focus: hit }
    d.focusRow(hit)
  }

  function onKeydown(e: KeyboardEvent) {
    d.beforeKey?.()
    if (d.isRenaming()) return
    if ((e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return
    if (navigate(e) || command(e) || shortcut(e)) {
      e.preventDefault()
      return
    }
    jumpTo(e)
  }

  return { onKeydown }
}
