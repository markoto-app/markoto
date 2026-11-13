import type { Command, KeyBinding } from '@codemirror/view'
import {
  addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, defaultKeymap, deleteLine,
  historyKeymap, indentLess, indentMore, indentWithTab, insertBlankLine, moveLineDown,
  moveLineUp, redo, selectLine, toggleComment, undo
} from '@codemirror/commands'
import { insertNewlineContinueMarkup, markdownKeymap } from '@codemirror/lang-markdown'
import { formattingKeymap } from '~/utils/editor/editorCommands'
import { isMacPlatform } from '~/utils/preview/previewZoom'

/**
 * The list behind Help → Keyboard shortcuts. Editor rows are looked up in
 * the very keymaps EditorPane.vue installs (formattingKeymap,
 * markdownKeymap, defaultKeymap, historyKeymap, indentWithTab), by
 * command, so the sheet can't promise a binding the editor doesn't have.
 * The few shortcuts handled outside CodeMirror (print, preview zoom,
 * posting a comment) are listed with the key their handler checks.
 */

export type ShortcutPlatform = 'mac' | 'windows' | 'linux'

export interface ShortcutRow {
  /** i18n key of the action's name. */
  labelKey: string
  /** One or more key combinations, CodeMirror notation ("Mod-Shift-z"). */
  combos: string[]
}

export interface ShortcutGroup {
  /** i18n key of the group heading. */
  titleKey: string
  rows: ShortcutRow[]
}

const EDITOR_KEYMAPS: readonly (readonly KeyBinding[])[] = [formattingKeymap, markdownKeymap, defaultKeymap, historyKeymap, [indentWithTab]]

/** The binding's key on `platform` (CodeMirror's own platform overrides), or null. */
function keyOn(b: KeyBinding, platform: ShortcutPlatform): string | null {
  const own = platform === 'mac' ? b.mac : platform === 'windows' ? b.win : b.linux
  return own ?? b.key ?? null
}

/**
 * The first key bound to `run` (or, with `shift`, its Shift variant) on
 * `platform`, searching `maps` (default: every keymap the editor installs,
 * in its precedence order).
 */
export function keyForCommand(run: Command, platform: ShortcutPlatform, shift = false, maps: readonly (readonly KeyBinding[])[] = EDITOR_KEYMAPS): string | null {
  const key = maps.flat()
    .filter(b => (shift ? b.shift : b.run) === run)
    .map(b => keyOn(b, platform))
    .find(k => k !== null && k !== '')
  if (!key) return null
  return shift ? `Shift-${key}` : key
}

/** The key of a formatting binding (formattingKeymap wraps each in its own closure). */
function formattingKey(key: string): string | null {
  return formattingKeymap.some(b => b.key === key) ? key : null
}

function present(...combos: Array<string | null>): string[] {
  return combos.filter((c): c is string => c !== null)
}

/** Every group and row, resolved for `platform`. Rows whose binding is missing are dropped. */
export function shortcutGroups(platform: ShortcutPlatform): ShortcutGroup[] {
  const cmd = (run: Command, shift = false) => keyForCommand(run, platform, shift)
  // Indenting is also on Mod-] / Mod-[; Tab is the one people reach for.
  const tab = (shift: boolean) => keyForCommand(shift ? indentLess : indentMore, platform, shift, [[indentWithTab]])
  const groups: ShortcutGroup[] = [
    {
      titleKey: 'shortcuts.groups.format',
      rows: [
        { labelKey: 'editor.bold', combos: present(formattingKey('Mod-b')) },
        { labelKey: 'editor.italic', combos: present(formattingKey('Mod-i')) },
        { labelKey: 'editor.hideFromPreview', combos: present(cmd(toggleComment)) }
      ]
    },
    {
      titleKey: 'shortcuts.groups.document',
      rows: [
        // EditorLayout.vue's capture-phase Cmd/Ctrl+P handler.
        { labelKey: 'menubar.file.print', combos: ['Mod-p'] },
        // CommentComposer.vue: Cmd/Ctrl+Enter posts.
        { labelKey: 'shortcuts.postComment', combos: ['Mod-Enter'] }
      ]
    },
    {
      // previewZoom.ts#zoomShortcutAction, pointer over the preview.
      titleKey: 'shortcuts.groups.preview',
      rows: [
        { labelKey: 'previewZoom.zoomIn', combos: ['Mod-='] },
        { labelKey: 'previewZoom.zoomOut', combos: ['Mod--'] },
        { labelKey: 'previewZoom.fitWidth', combos: ['Mod-0'] }
      ]
    },
    {
      titleKey: 'shortcuts.groups.edit',
      rows: [
        { labelKey: 'menubar.edit.undo', combos: present(cmd(undo)) },
        { labelKey: 'menubar.edit.redo', combos: present(cmd(redo)) },
        { labelKey: 'shortcuts.continueList', combos: present(cmd(insertNewlineContinueMarkup)) },
        { labelKey: 'shortcuts.indent', combos: present(tab(false), tab(true)) },
        { labelKey: 'shortcuts.blankLine', combos: present(cmd(insertBlankLine)) },
        { labelKey: 'shortcuts.moveLine', combos: present(cmd(moveLineUp), cmd(moveLineDown)) },
        { labelKey: 'shortcuts.copyLine', combos: present(cmd(copyLineUp), cmd(copyLineDown)) },
        { labelKey: 'shortcuts.deleteLine', combos: present(cmd(deleteLine)) },
        { labelKey: 'shortcuts.selectLine', combos: present(cmd(selectLine)) },
        { labelKey: 'shortcuts.addCursor', combos: present(cmd(addCursorAbove), cmd(addCursorBelow)) }
      ]
    }
  ]
  return groups.map(g => ({ ...g, rows: g.rows.filter(r => r.combos.length > 0) }))
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Cmd: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backspace: 'Backspace'
}

/**
 * "Shift-Mod-k" → ["⇧", "⌘", "K"] on a Mac, ["Shift", "Ctrl", "K"]
 * elsewhere: one entry per key chip. The last part may itself be "-"
 * ("Mod--" = zoom out).
 */
export function comboKeys(combo: string, platform: ShortcutPlatform): string[] {
  const parts = combo.endsWith('--') ? [...combo.slice(0, -2).split('-'), '-'] : combo.split('-')
  return parts.filter(p => p !== '').map((p, i) => {
    const last = i === parts.length - 1
    if (!last) {
      if (platform === 'mac') return MAC_SYMBOLS[p] ?? p
      return p === 'Mod' ? 'Ctrl' : p
    }
    return KEY_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)
  })
}

/** The visitor's platform, from the same signal the print and zoom handlers use. */
export function currentShortcutPlatform(): ShortcutPlatform {
  if (isMacPlatform()) return 'mac'
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) return 'windows'
  return 'linux'
}
