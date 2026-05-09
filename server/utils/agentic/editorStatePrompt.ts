import {
  type EditorSelectionSnapshot,
  EDITOR_SELECTION_TEXT_MAX,
  CURSOR_MARKER,
  EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE
} from '~~/shared/types/editorSelection'

// Server-side cap on the line-with-cursor payload. `each side + marker + …`
// on both sides is the theoretical max; a little slack handles UTF-16
// surrogate pairs pushing the length over by a char.
const CURSOR_LINE_TEXT_MAX = EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE * 2 + CURSOR_MARKER.length + 4

/**
 * Validate the `editorSelection` field coming in on the `/api/ai/prompt`
 * body. We deliberately fall back to `kind: 'none'` on ANY malformed
 * shape instead of throwing — a stale or buggy client snapshot should
 * not block an otherwise-valid prompt. Hard-rejecting here would also
 * give the client a confusing 400 for a field they never typed.
 *
 * Exported so the unit tests can hit every branch without booting Nuxt.
 */
export function validateEditorSelection(raw: unknown): EditorSelectionSnapshot {
  if (!raw || typeof raw !== 'object') return { kind: 'none' }
  const r = raw as Record<string, unknown>
  if (r.kind === 'cursor') return validateCursorSelection(r)
  if (r.kind === 'selection') return validateRangeSelection(r)
  return { kind: 'none' }
}

/**
 * Validate a `kind: cursor` snapshot. Required: line ≥ 1, column ≥ 1,
 * lineText containing the literal `<CURSOR_IS_HERE>` marker. Returns
 * `kind: 'none'` on any failure — the loop's editor-state-routing
 * rules must not act on an ambiguous snapshot.
 *
 * Defense-in-depth: clamp `lineText` to `CURSOR_LINE_TEXT_MAX` by
 * windowing AROUND the marker so it survives the slice. Naive head-
 * slicing would strip it and invalidate the snapshot.
 */
function validateCursorSelection(r: Record<string, unknown>): EditorSelectionSnapshot {
  if (!Number.isInteger(r.line) || (r.line as number) < 1) return { kind: 'none' }
  if (!Number.isInteger(r.column) || (r.column as number) < 1) return { kind: 'none' }
  if (typeof r.lineText !== 'string') return { kind: 'none' }
  const markerIdx = r.lineText.indexOf(CURSOR_MARKER)
  if (markerIdx < 0) return { kind: 'none' }

  const { lineText, lineTruncated } = clampCursorLineText(r.lineText, markerIdx, r.lineTruncated === true)
  return {
    kind: 'cursor',
    line: r.line as number,
    column: r.column as number,
    lineText,
    lineTruncated
  }
}

/**
 * Window an over-long `lineText` around the marker so the marker
 * survives the slice. Adds `…` sentinels on the trimmed sides so the
 * model can tell the line was windowed.
 */
function clampCursorLineText(lineText: string, markerIdx: number, alreadyTruncated: boolean): { lineText: string, lineTruncated: boolean } {
  if (lineText.length <= CURSOR_LINE_TEXT_MAX) {
    return { lineText, lineTruncated: alreadyTruncated }
  }
  const each = EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE
  const before = lineText.slice(0, markerIdx)
  const after = lineText.slice(markerIdx + CURSOR_MARKER.length)
  const b = before.length > each ? '…' + before.slice(before.length - each) : before
  const a = after.length > each ? after.slice(0, each) + '…' : after
  return { lineText: b + CURSOR_MARKER + a, lineTruncated: true }
}

/**
 * Validate a `kind: selection` snapshot. Required: integer fromLine
 * ≥ 1, integer toLine ≥ fromLine, string text. Server-side clamp on
 * `text` length is defense in depth — a malicious client could
 * otherwise stuff the prompt with multi-megabyte content.
 */
function validateRangeSelection(r: Record<string, unknown>): EditorSelectionSnapshot {
  const fromLine = r.fromLine
  const toLine = r.toLine
  const text = r.text
  if (
    !Number.isInteger(fromLine)
    || !Number.isInteger(toLine)
    || (fromLine as number) < 1
    || (toLine as number) < (fromLine as number)
    || typeof text !== 'string'
  ) return { kind: 'none' }

  const cappedText = text.length > EDITOR_SELECTION_TEXT_MAX + 1
    ? text.slice(0, EDITOR_SELECTION_TEXT_MAX) + '…'
    : text
  return {
    kind: 'selection',
    fromLine: fromLine as number,
    toLine: toLine as number,
    text: cappedText,
    truncated: r.truncated === true || cappedText !== text
  }
}

/**
 * Wrap the user's prompt with an `<editor_state>` block describing their
 * cursor or selection at submit time. Returned verbatim for `kind: none`
 * — no wrapper, no tokens wasted — so a default-state request is
 * indistinguishable (to the model) from the pre-feature behavior.
 *
 * The XML-ish tags are a readability convention for the model; modern
 * LLMs are trained well on structured user messages wrapped this way.
 * Keep the format stable — the system prompt tells the model exactly
 * what keys to look for inside.
 */
export function wrapPromptWithEditorState(
  prompt: string,
  selection: EditorSelectionSnapshot
): string {
  if (selection.kind === 'none') return prompt

  let state: string
  if (selection.kind === 'cursor') {
    // JSON-stringify the line_content so any embedded newlines (shouldn't
    // happen — line N is by definition single-line — but defence in
    // depth) and special chars are safely escaped.
    const lineContent = JSON.stringify(selection.lineText)
    state = [
      'kind: cursor',
      `cursor_line: ${selection.line}`,
      `cursor_column: ${selection.column}`,
      `line_content: ${lineContent}`,
      selection.lineTruncated ? 'line_truncated: true' : ''
    ].filter(Boolean).join('\n')
  } else {
    // Escape any stray `</user_request>` inside the selection so a user
    // who literally pasted that string into the doc can't trick the
    // parser. Extremely unlikely but cheap to prevent.
    const safeText = selection.text.replace(/<\/user_request>/gi, '</user_request-escaped>')
    state = [
      'kind: selection',
      `selection_lines: ${selection.fromLine}-${selection.toLine}`,
      `selection_text: ${JSON.stringify(safeText)}`,
      selection.truncated ? 'truncated: true' : ''
    ].filter(Boolean).join('\n')
  }

  return `<editor_state>\n${state}\n</editor_state>\n\n<user_request>\n${prompt}\n</user_request>`
}

/**
 * System-prompt-side guidance: tells the model how to interpret an
 * `<editor_state>` block when one is present. Lives next to the
 * validator + wrapper so all editor-state knowledge has a single
 * file. Imported into the system-prompt assembly in
 * `server/api/ai/prompt.post.ts`.
 *
 * Two routing axes the model must get right:
 *   1. Cursor placement: insert_text inserts AFTER a line, so to put
 *      content AT the cursor you pass `insert_line: N - 1`. The
 *      cursor's line content carries a literal `<CURSOR_IS_HERE>`
 *      marker — split on the marker, don't count characters.
 *   2. Selection range: replace_text against the exact selection.
 */
export const EDITOR_STATE_INSTRUCTIONS = `Editor state (cursor / selection context):
- Each user message may be wrapped in \`<editor_state>...</editor_state>\` followed by \`<user_request>...</user_request>\`. The editor_state block is GROUND TRUTH for where the user is in the document — always prefer it over guessing or asking.

- \`kind: cursor\` — caret on line \`cursor_line\` (1-indexed). \`line_content\` carries the full line with the literal marker \`<CURSOR_IS_HERE>\` spliced at the caret. Split on the marker (never count characters) to get \`before\` and \`after\`. If \`line_truncated: true\`, \`line_content\` was windowed with \`…\` sentinels — call \`view_document({ view_range: [cursor_line, cursor_line] })\` first.

  CRITICAL insert semantics — the obvious choice is wrong:
  - \`insert_text({ insert_line: N })\` inserts AFTER line N (new line below).
  - To place a block AT the user's cursor (so the inserted block visually appears where they're looking), call \`insert_text({ insert_line: N - 1 })\`. When N === 1, use \`insert_line: 0\`.
  - Use \`insert_text({ insert_line: N })\` ONLY for explicit "after this", "continue", "next" requests.

  Routing — pick the tool from \`before\`, \`after\`, and the edit shape:

  (a) \`before\` empty / whitespace-only (caret at start of line): \`insert_text({ insert_line: N - 1 })\`. New block lands at line N's position; previous line N pushed down.

  (b) \`after\` empty / whitespace-only (caret at end of line): \`insert_text({ insert_line: N })\`. Block lands after line N.

  (c) Both \`before\` and \`after\` non-empty (mid-line caret): \`insert_text\` cannot split a line — use \`replace_text\`:
     - \`old_str\` = \`line_content\` with the marker deleted (= the verbatim original line N).
     - \`new_str\`:
       * Inline extension ("add 'and pears' here"): \`before + <new content> + after\` (no line breaks).
       * Block insert ("add a paragraph here"): \`before + '\\n\\n' + <new block> + '\\n\\n' + after\` (splits line N).
     - If \`line_truncated: true\`, \`view_document({ view_range: [N, N] })\` to recover the full line first.
     - If \`replace_text\` returns "Found N matches", widen the anchor to include line N-1 / N+1 verbatim.

  For "what's this section about?" / "summarize what I'm looking at": \`view_document({ view_range: [max(1, N-20), N+20] })\` then answer.

- \`kind: selection\` with \`selection_lines: X-Y\` and \`selection_text: "..."\` — the user has lines X–Y selected. For "rewrite this", "fix this", "translate this", "make this shorter" etc., operate on that exact range via \`replace_text\` (old_str = the full selection or a unique substring). If \`selection_text\` ends with \`…\` it was truncated — \`view_document({ view_range: [X, Y] })\` first.

- No \`<editor_state>\` block, or \`kind: none\` — the user's focus is not in the document. If the request is about "this" / "here" / "where I am", clarify or \`view_document\` and pick a sensible location based on content. If self-contained ("write an article about X"), proceed normally.

- An explicit location in the user's request ("add to the intro", "replace the conclusion", "change line 50") WINS over editor_state.`
