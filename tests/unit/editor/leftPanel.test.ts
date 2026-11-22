import { describe, it, expect } from 'vitest'
import {
  LEFT_PANEL_STORAGE_KEY, initialLeftPanelState, isLeftPanelShortcut, readLeftPanelPrefs, writeLeftPanelPrefs
} from '../../../app/utils/editor/leftPanel'
import { shortcutGroups } from '../../../app/utils/editor/keyboardShortcuts'

// The editor's left panel: what the browser remembers, how it starts, its shortcut.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    data
  }
}

const key = (k: string, opts: { ctrl?: boolean, meta?: boolean, shift?: boolean, alt?: boolean, code?: string } = {}) => ({
  key: k,
  code: opts.code ?? `Key${k.toUpperCase()}`,
  ctrlKey: opts.ctrl ?? false,
  metaKey: opts.meta ?? false,
  shiftKey: opts.shift ?? false,
  altKey: opts.alt ?? false
})

describe('left panel preferences', () => {
  it('round-trips open state and tab', () => {
    const storage = memoryStorage()
    writeLeftPanelPrefs(storage, { open: true, tab: 'workspace' })
    expect(storage.data.get(LEFT_PANEL_STORAGE_KEY)).toBe('{"open":true,"tab":"workspace"}')
    expect(readLeftPanelPrefs(storage)).toEqual({ open: true, tab: 'workspace' })
  })

  it('reads nothing from empty, blocked or garbled storage', () => {
    expect(readLeftPanelPrefs(null)).toBeNull()
    expect(readLeftPanelPrefs(memoryStorage())).toBeNull()
    expect(readLeftPanelPrefs(memoryStorage({ [LEFT_PANEL_STORAGE_KEY]: 'not json' }))).toBeNull()
    expect(readLeftPanelPrefs(memoryStorage({ [LEFT_PANEL_STORAGE_KEY]: '{"tab":"outline"}' }))).toBeNull()
    expect(readLeftPanelPrefs(memoryStorage({ [LEFT_PANEL_STORAGE_KEY]: 'null' }))).toBeNull()
    const blocked = (): never => {
      throw new Error('SecurityError')
    }
    expect(readLeftPanelPrefs({ getItem: blocked })).toBeNull()
  })

  it('falls back to the outline for an unknown tab', () => {
    expect(readLeftPanelPrefs(memoryStorage({ [LEFT_PANEL_STORAGE_KEY]: '{"open":false,"tab":"files"}' }))).toEqual({ open: false, tab: 'outline' })
  })

  it('never throws when storage refuses a write', () => {
    const full = (): never => {
      throw new Error('QuotaExceededError')
    }
    expect(() => writeLeftPanelPrefs({ setItem: full }, { open: true, tab: 'outline' })).not.toThrow()
    expect(() => writeLeftPanelPrefs(null, { open: true, tab: 'outline' })).not.toThrow()
  })
})

describe('left panel start state', () => {
  it('first visit: open with the outline on wide screens only', () => {
    expect(initialLeftPanelState(null, { inline: true, wide: true })).toEqual({ open: true, tab: 'outline' })
    expect(initialLeftPanelState(null, { inline: true, wide: false })).toEqual({ open: false, tab: 'outline' })
    expect(initialLeftPanelState(null, { inline: false, wide: false })).toEqual({ open: false, tab: 'outline' })
  })

  it('a remembered choice wins beside the editor, and an overlay never opens by itself', () => {
    expect(initialLeftPanelState({ open: true, tab: 'workspace' }, { inline: true, wide: false })).toEqual({ open: true, tab: 'workspace' })
    expect(initialLeftPanelState({ open: false, tab: 'outline' }, { inline: true, wide: true })).toEqual({ open: false, tab: 'outline' })
    expect(initialLeftPanelState({ open: true, tab: 'workspace' }, { inline: false, wide: false })).toEqual({ open: false, tab: 'workspace' })
  })
})

describe('left panel shortcut', () => {
  it('is Ctrl+Shift+E, or Cmd+Shift+E on a Mac', () => {
    expect(isLeftPanelShortcut(key('E', { ctrl: true, shift: true }), false)).toBe(true)
    expect(isLeftPanelShortcut(key('E', { meta: true, shift: true }), true)).toBe(true)
    expect(isLeftPanelShortcut(key('E', { meta: true, shift: true }), false)).toBe(false)
    expect(isLeftPanelShortcut(key('E', { ctrl: true, shift: true }), true)).toBe(false)
  })

  it('needs Shift and no Alt, and only E', () => {
    expect(isLeftPanelShortcut(key('e', { ctrl: true }), false)).toBe(false)
    expect(isLeftPanelShortcut(key('E', { ctrl: true, shift: true, alt: true }), false)).toBe(false)
    expect(isLeftPanelShortcut(key('F', { ctrl: true, shift: true }), false)).toBe(false)
  })

  it('matches the physical key on a non-Latin layout, the letter on a Latin one', () => {
    expect(isLeftPanelShortcut(key('У', { ctrl: true, shift: true, code: 'KeyE' }), false)).toBe(true)
    // Dvorak: the key in the E position types a period, E sits elsewhere.
    expect(isLeftPanelShortcut(key('.', { ctrl: true, shift: true, code: 'KeyE' }), false)).toBe(true)
    expect(isLeftPanelShortcut(key('P', { ctrl: true, shift: true, code: 'KeyE' }), false)).toBe(false)
  })

  it('is listed under Help → Keyboard shortcuts on every platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      const rows = shortcutGroups(platform).flatMap(g => g.rows)
      expect(rows.find(r => r.labelKey === 'leftPanel.label')?.combos).toEqual(['Mod-Shift-e'])
    }
  })
})
