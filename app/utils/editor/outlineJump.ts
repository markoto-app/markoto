import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** How far below the top of the editor a heading lands after a jump. */
const OUTLINE_JUMP_MARGIN_PX = 48

/**
 * Put the cursor at the end of the 0-based `line` (a heading from the
 * outline, so typing continues its title and Enter starts the section) and
 * scroll the line to the top of the editor. A line past the end (the text
 * changed since the outline was built) goes to the last line.
 */
export function jumpEditorToLine(view: EditorView, line: number, opts: { focus?: boolean } = {}): void {
  const doc = view.state.doc
  const target = doc.line(Math.min(Math.max(line + 1, 1), doc.lines))
  view.dispatch({
    selection: EditorSelection.cursor(target.to),
    effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: OUTLINE_JUMP_MARGIN_PX }),
    userEvent: 'select'
  })
  if (opts.focus !== false) view.focus()
}

/**
 * The 0-based line the editor's reading position is at: the line a
 * little below the top of the visible text (past the margin a jump leaves
 * above a heading).
 */
export function topVisibleLine(view: EditorView): number {
  const scrollerTop = view.scrollDOM.getBoundingClientRect().top
  const probe = Math.min(OUTLINE_JUMP_MARGIN_PX * 2, view.scrollDOM.clientHeight / 4)
  const block = view.lineBlockAtHeight(Math.max(0, scrollerTop - view.documentTop + probe))
  return view.state.doc.lineAt(block.from).number - 1
}
