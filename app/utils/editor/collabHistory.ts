import type { Command, KeyBinding } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdownKeymap } from '@codemirror/lang-markdown'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import { formattingKeymap } from '~/utils/editor/editorCommands'

/**
 * Undo / redo in the collaborative editor run on the document's
 * `Y.UndoManager` (y-codemirror.next's `yUndoManagerKeymap`), never on
 * CodeMirror's own `history()`. CodeMirror's history records every
 * transaction that changes the editor text, including the one that loads
 * the synced document and every edit a collaborator or the AI makes, so
 * Ctrl+Z in a freshly opened tab could take back the whole document. The
 * UndoManager only tracks this tab's own edits.
 */
function bindingFor(key: string): Command {
  const run = yUndoManagerKeymap.find(b => b.key === key)?.run
  if (!run) throw new Error(`y-codemirror.next has no ${key} binding`)
  return run
}

export const collabUndo: Command = bindingFor('Mod-z')
export const collabRedo: Command = bindingFor('Mod-Shift-z')

/**
 * Every key binding of the collaborative editor, in precedence order.
 * markdownKeymap goes before defaultKeymap so it wins Enter / Backspace
 * (list continuation); formattingKeymap first for Mod-b / Mod-i.
 */
export const editorKeymap: readonly KeyBinding[] = [
  ...formattingKeymap,
  ...markdownKeymap,
  ...defaultKeymap,
  ...yUndoManagerKeymap,
  indentWithTab
]

/**
 * Transaction origin for text the editor writes on its own (the template
 * a new document starts with). The UndoManager does not track it, so undo
 * never takes back the starting text.
 */
export const TEMPLATE_SEED_ORIGIN = 'markoto:template-seed'
