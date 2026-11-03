import { describe, it, expect } from 'vitest'
import { moveLineUp, redo, toggleComment, undo } from '@codemirror/commands'
import { comboKeys, keyForCommand, shortcutGroups, type ShortcutPlatform } from '../../app/utils/keyboardShortcuts'

// Help → Keyboard shortcuts must only list bindings the editor really has.
// The rows are resolved from the editor's own keymaps, so these tests pin
// both the lookup and the expected result for the shortcuts we advertise.

const PLATFORMS: ShortcutPlatform[] = ['mac', 'windows', 'linux']

function combosFor(platform: ShortcutPlatform, labelKey: string): string[] | undefined {
  for (const g of shortcutGroups(platform)) {
    const row = g.rows.find(r => r.labelKey === labelKey)
    if (row) return row.combos
  }
  return undefined
}

describe('keyForCommand', () => {
  it('finds the bindings EditorPane installs', () => {
    expect(keyForCommand(undo, 'mac')).toBe('Mod-z')
    expect(keyForCommand(toggleComment, 'windows')).toBe('Mod-/')
    expect(keyForCommand(moveLineUp, 'linux')).toBe('Alt-ArrowUp')
  })

  it('uses CodeMirror\'s platform overrides', () => {
    expect(keyForCommand(redo, 'mac')).toBe('Mod-Shift-z')
    expect(keyForCommand(redo, 'windows')).toBe('Mod-y')
  })

  it('returns null for a command no keymap binds', () => {
    const unbound = () => false
    expect(keyForCommand(unbound, 'mac')).toBeNull()
  })
})

describe('shortcutGroups', () => {
  it('lists every advertised shortcut on every platform', () => {
    for (const p of PLATFORMS) {
      expect(combosFor(p, 'editor.bold'), p).toEqual(['Mod-b'])
      expect(combosFor(p, 'editor.italic'), p).toEqual(['Mod-i'])
      expect(combosFor(p, 'editor.hideFromPreview'), p).toEqual(['Mod-/'])
      expect(combosFor(p, 'menubar.edit.undo'), p).toEqual(['Mod-z'])
      expect(combosFor(p, 'shortcuts.indent'), p).toEqual(['Tab', 'Shift-Tab'])
      expect(combosFor(p, 'shortcuts.continueList'), p).toEqual(['Enter'])
      expect(combosFor(p, 'shortcuts.deleteLine'), p).toEqual(['Shift-Mod-k'])
      expect(combosFor(p, 'menubar.file.print'), p).toEqual(['Mod-p'])
    }
    expect(combosFor('mac', 'shortcuts.selectLine')).toEqual(['Ctrl-l'])
    expect(combosFor('windows', 'shortcuts.selectLine')).toEqual(['Alt-l'])
  })

  it('never keeps a row without a key', () => {
    for (const p of PLATFORMS) {
      for (const g of shortcutGroups(p)) {
        expect(g.rows.length, g.titleKey).toBeGreaterThan(0)
        for (const r of g.rows) expect(r.combos.length, r.labelKey).toBeGreaterThan(0)
      }
    }
  })
})

describe('comboKeys', () => {
  it('uses symbols on a Mac and names elsewhere', () => {
    expect(comboKeys('Shift-Mod-k', 'mac')).toEqual(['⇧', '⌘', 'K'])
    expect(comboKeys('Shift-Mod-k', 'windows')).toEqual(['Shift', 'Ctrl', 'K'])
    expect(comboKeys('Alt-ArrowUp', 'linux')).toEqual(['Alt', '↑'])
    expect(comboKeys('Mod-/', 'mac')).toEqual(['⌘', '/'])
  })

  it('keeps a trailing minus as the key', () => {
    expect(comboKeys('Mod--', 'windows')).toEqual(['Ctrl', '-'])
    expect(comboKeys('Mod-=', 'mac')).toEqual(['⌘', '='])
  })
})
