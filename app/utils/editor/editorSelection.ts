import type { EditorView } from '@codemirror/view'
import {
  type EditorSelectionSnapshot,
  EDITOR_SELECTION_TEXT_MAX,
  CURSOR_MARKER,
  EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE
} from '~~/shared/types/editorSelection'

// Re-export NOT added here — the type lives in shared/types and is
// auto-imported. Re-exporting from this file triggers a "duplicated
// imports" warning from Nuxt's auto-import machinery.

/**
 * Splice `<CURSOR_IS_HERE>` into the line at the caret column. If the
 * line is longer than can reasonably ship with the prompt, window
 * around the cursor with `…` markers on either side so the AI still
 * sees the immediate context — it'll call `view_document` for the
 * full line when it's time to build `old_str`.
 *
 * Escapes any pre-existing `<CURSOR_IS_HERE>` in the line so an
 * attacker (or a user who literally typed the marker into their doc)
 * can't confuse the model about where the caret really is.
 */
function buildCursorLineText(
  fullLine: string,
  column: number
): { text: string, truncated: boolean } {
  // 1-indexed column → 0-indexed insert position.
  const cursorIdx = Math.max(0, Math.min(fullLine.length, column - 1))
  const safeLine = fullLine.replaceAll(CURSOR_MARKER, '<cursor-in-doc>')
  const before = safeLine.slice(0, cursorIdx)
  const after = safeLine.slice(cursorIdx)

  const each = EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE
  const beforeTrim = before.length > each
  const afterTrim = after.length > each

  const beforeWindow = beforeTrim ? '…' + before.slice(before.length - each) : before
  const afterWindow = afterTrim ? after.slice(0, each) + '…' : after

  return {
    text: beforeWindow + CURSOR_MARKER + afterWindow,
    truncated: beforeTrim || afterTrim
  }
}

/**
 * Read the current CodeMirror selection into a serializable snapshot for
 * the AI prompt endpoint. Returns `{ kind: 'none' }` when:
 *   - the view isn't mounted yet (editor hidden behind a password gate,
 *     mobile collapsed view, etc.), OR
 *   - the user has never focused the editor in this session.
 *
 * The `everFocused` gate is the signal that separates "initial CM6 state
 * at doc load" (cursor sits at position 0 by default) from "user placed
 * the cursor at line 1". Without it, every freshly-opened doc would
 * report a cursor on line 1, even if the user is typing their prompt
 * without having ever clicked into the doc.
 */
export function snapshotEditorSelection(
  view: EditorView | null,
  everFocused: boolean
): EditorSelectionSnapshot {
  if (!view || !everFocused) return { kind: 'none' }

  const sel = view.state.selection.main
  const doc = view.state.doc

  if (sel.empty) {
    const line = doc.lineAt(sel.from)
    const column = sel.from - line.from + 1 // 1-indexed
    const { text, truncated } = buildCursorLineText(line.text, column)
    return {
      kind: 'cursor',
      line: line.number,
      column,
      lineText: text,
      lineTruncated: truncated
    }
  }

  const fromLine = doc.lineAt(sel.from).number
  const toLine = doc.lineAt(sel.to).number
  const raw = view.state.sliceDoc(sel.from, sel.to)
  const truncated = raw.length > EDITOR_SELECTION_TEXT_MAX
  const text = truncated ? raw.slice(0, EDITOR_SELECTION_TEXT_MAX) + '…' : raw

  return { kind: 'selection', fromLine, toLine, text, truncated }
}
