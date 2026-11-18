import { describe, it, expect, vi, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import { docItem, folderItem, type ExplorerItem } from '~/utils/explorer/model'
import { EMPTY_SELECTION, type SelectionState } from '~/utils/explorer/selection'
import { useExplorerKeyboard } from '~/composables/explorer/useExplorerKeyboard'
import { doc, folder } from './fixtures'

// The explorer list's keyboard, driven with synthetic keydown events.

function setup(opts: { renaming?: boolean, canWrite?: boolean, selection?: Partial<SelectionState> } = {}) {
  const items = ref<ExplorerItem[]>([
    folderItem(folder('f1', null, 'Archive')),
    docItem(doc('d1', null, 'Budget')),
    docItem(doc('d2', null, 'Brief')),
    docItem(doc('d3', null, 'Chart'))
  ])
  const keys = computed(() => items.value.map(i => i.key))
  const byKey = computed(() => new Map(items.value.map(i => [i.key, i])))
  const selection = ref<SelectionState>({ ...EMPTY_SELECTION, ...opts.selection })
  const selectedItems = computed(() => items.value.filter(i => selection.value.selected.has(i.key)))
  const d = {
    selection,
    keys,
    items,
    byKey,
    selectedItems,
    isRenaming: () => opts.renaming ?? false,
    canWrite: () => opts.canWrite ?? true,
    focusRow: vi.fn(),
    open: vi.fn(),
    goUp: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    undo: vi.fn(),
    newFolder: vi.fn(),
    clearCut: vi.fn(),
    beforeKey: vi.fn()
  }
  const { onKeydown } = useExplorerKeyboard(d)
  function press(key: string, init: KeyboardEventInit & { target?: EventTarget } = {}) {
    const { target, ...rest } = init
    const e = new KeyboardEvent('keydown', { key, cancelable: true, ...rest })
    if (target) Object.defineProperty(e, 'target', { value: target })
    onKeydown(e)
    return e
  }
  return { d, press, selection }
}

const sel = (s: SelectionState) => [...s.selected]

afterEach(() => {
  vi.useRealTimers()
})

describe('useExplorerKeyboard', () => {
  it('arrows move the focus and select it', () => {
    const { d, press, selection } = setup()
    const e = press('ArrowDown')
    expect(e.defaultPrevented).toBe(true)
    expect(selection.value.focus).toBe('f:f1')
    press('ArrowDown')
    expect(sel(selection.value)).toEqual(['d:d1'])
    expect(d.focusRow).toHaveBeenLastCalledWith('d:d1')
    press('ArrowUp')
    expect(selection.value.focus).toBe('f:f1')
    expect(d.beforeKey).toHaveBeenCalledTimes(3)
  })

  it('Home / End / PageDown / PageUp jump', () => {
    const { press, selection } = setup()
    press('End')
    expect(selection.value.focus).toBe('d:d3')
    press('Home')
    expect(selection.value.focus).toBe('f:f1')
    press('PageDown')
    expect(selection.value.focus).toBe('d:d3')
    press('PageUp')
    expect(selection.value.focus).toBe('f:f1')
  })

  it('Shift extends the range, Ctrl moves the focus only', () => {
    const { press, selection } = setup({ selection: { selected: new Set(['f:f1']), anchor: 'f:f1', focus: 'f:f1' } })
    press('ArrowDown', { shiftKey: true })
    press('ArrowDown', { shiftKey: true })
    expect(sel(selection.value)).toEqual(['f:f1', 'd:d1', 'd:d2'])
    press('ArrowDown', { ctrlKey: true })
    expect(selection.value.focus).toBe('d:d3')
    expect(sel(selection.value)).toEqual(['f:f1', 'd:d1', 'd:d2'])
  })

  it('Ctrl+Space toggles the focused item; a plain space is typeahead', () => {
    const { press, selection } = setup({ selection: { selected: new Set(), anchor: null, focus: 'd:d1' } })
    expect(press(' ', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(sel(selection.value)).toEqual(['d:d1'])
    press(' ', { metaKey: true })
    expect(sel(selection.value)).toEqual([])
    expect(press(' ').defaultPrevented).toBe(false)
  })

  it('Enter opens the focused item, and does nothing without one', () => {
    const none = setup()
    expect(none.press('Enter').defaultPrevented).toBe(false)
    expect(none.d.open).not.toHaveBeenCalled()

    const { d, press } = setup({ selection: { focus: 'd:d2' } })
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(d.open).toHaveBeenCalledWith(expect.objectContaining({ key: 'd:d2' }))
  })

  it('Backspace and Alt+Up go to the parent', () => {
    const { d, press } = setup()
    press('Backspace')
    press('ArrowUp', { altKey: true })
    expect(d.goUp).toHaveBeenCalledTimes(2)
  })

  it('F2 renames the focused item', () => {
    const { d, press } = setup({ selection: { focus: 'd:d1' } })
    press('F2')
    expect(d.rename).toHaveBeenCalledWith('d:d1')
  })

  it('Delete removes the selection, else the focused item, else nothing', () => {
    const many = setup({ selection: { selected: new Set(['d:d1', 'd:d2']), focus: 'd:d3' } })
    many.press('Delete')
    expect(many.d.remove.mock.calls[0]![0].map((i: ExplorerItem) => i.key)).toEqual(['d:d1', 'd:d2'])

    const focusOnly = setup({ selection: { focus: 'd:d3' } })
    focusOnly.press('Delete')
    expect(focusOnly.d.remove.mock.calls[0]![0].map((i: ExplorerItem) => i.key)).toEqual(['d:d3'])

    const empty = setup()
    empty.press('Delete')
    expect(empty.d.remove).toHaveBeenCalledWith([])
  })

  it('Escape clears the selection and the cut, keeping the focus, and is not swallowed', () => {
    const { d, press, selection } = setup({ selection: { selected: new Set(['d:d1']), anchor: 'd:d1', focus: 'd:d1' } })
    const e = press('Escape')
    expect(e.defaultPrevented).toBe(false)
    expect(sel(selection.value)).toEqual([])
    expect(selection.value.focus).toBe('d:d1')
    expect(d.clearCut).toHaveBeenCalledOnce()
  })

  it('Ctrl+A / X / V / Z', () => {
    const { d, press, selection } = setup()
    press('a', { ctrlKey: true })
    expect(sel(selection.value)).toHaveLength(4)
    press('X', { metaKey: true })
    expect(d.cut.mock.calls[0]![0]).toHaveLength(4)
    press('v', { ctrlKey: true })
    expect(d.paste).toHaveBeenCalledOnce()
    press('z', { ctrlKey: true })
    expect(d.undo).toHaveBeenCalledOnce()
    // Another Ctrl shortcut is left to the browser.
    expect(press('p', { ctrlKey: true }).defaultPrevented).toBe(false)
    // Ctrl+Alt is not ours either.
    expect(press('a', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false)
  })

  it('Alt+N makes a folder only when the person may write', () => {
    const writer = setup()
    expect(writer.press('n', { altKey: true, code: 'KeyN' }).defaultPrevented).toBe(true)
    expect(writer.d.newFolder).toHaveBeenCalledOnce()

    const reader = setup({ canWrite: false })
    reader.press('n', { altKey: true, code: 'KeyN' })
    expect(reader.d.newFolder).not.toHaveBeenCalled()
  })

  it('typing jumps to a name; the prefix resets after a pause', () => {
    vi.useFakeTimers()
    const { d, press, selection } = setup()
    press('b')
    expect(selection.value.focus).toBe('d:d1')
    press('r')
    expect(selection.value.focus).toBe('d:d2')
    expect(d.focusRow).toHaveBeenLastCalledWith('d:d2')
    vi.advanceTimersByTime(800)
    press('c')
    expect(sel(selection.value)).toEqual(['d:d3'])
    // No match keeps the selection.
    press('z')
    expect(selection.value.focus).toBe('d:d3')
    // Multi-char keys and modified keys are not typeahead.
    press('Tab')
    press('b', { altKey: true })
    expect(selection.value.focus).toBe('d:d3')
  })

  it('does nothing while renaming, but still cancels a pending rename', () => {
    const { d, press, selection } = setup({ renaming: true })
    press('ArrowDown')
    expect(d.beforeKey).toHaveBeenCalledOnce()
    expect(selection.value.focus).toBeNull()
  })

  it('ignores keys typed into a field', () => {
    const { press, selection } = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('ArrowDown', { target: input })
    expect(selection.value.focus).toBeNull()
    input.remove()
  })
})
