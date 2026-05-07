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

  if (r.kind === 'none') return { kind: 'none' }

  if (r.kind === 'cursor') {
    if (!Number.isInteger(r.line) || (r.line as number) < 1) return { kind: 'none' }
    if (!Number.isInteger(r.column) || (r.column as number) < 1) return { kind: 'none' }
    if (typeof r.lineText !== 'string') return { kind: 'none' }
    // The marker must be present — the AI's split-on-marker rule is
    // the whole point of shipping line_content. Reject ambiguous
    // snapshots rather than shipping them to the model.
    const markerIdx = r.lineText.indexOf(CURSOR_MARKER)
    if (markerIdx < 0) return { kind: 'none' }
    // Defense-in-depth cap: a compromised client shouldn't be able to
    // stuff the prompt with an arbitrarily long "line_content". If
    // we have to cut, window AROUND the marker so it survives the
    // slice — naive head-slicing would strip it and invalidate the
    // whole snapshot.
    let lineText = r.lineText
    let lineTruncated = r.lineTruncated === true
    if (lineText.length > CURSOR_LINE_TEXT_MAX) {
      const each = EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE
      const before = lineText.slice(0, markerIdx)
      const after = lineText.slice(markerIdx + CURSOR_MARKER.length)
      const beforeTrim = before.length > each
      const afterTrim = after.length > each
      const b = beforeTrim ? '…' + before.slice(before.length - each) : before
      const a = afterTrim ? after.slice(0, each) + '…' : after
      lineText = b + CURSOR_MARKER + a
      lineTruncated = true
    }
    return {
      kind: 'cursor',
      line: r.line as number,
      column: r.column as number,
      lineText,
      lineTruncated
    }
  }

  if (r.kind === 'selection') {
    const fromLine = r.fromLine
    const toLine = r.toLine
    const text = r.text
    const truncated = r.truncated
    if (
      !Number.isInteger(fromLine)
      || !Number.isInteger(toLine)
      || (fromLine as number) < 1
      || (toLine as number) < (fromLine as number)
      || typeof text !== 'string'
    ) return { kind: 'none' }
    // Server-side clamp in addition to the client-side cap — defense in
    // depth. A malicious client could try to stuff the prompt with a
    // multi-megabyte "selection_text".
    const cappedText = text.length > EDITOR_SELECTION_TEXT_MAX + 1
      ? text.slice(0, EDITOR_SELECTION_TEXT_MAX) + '…'
      : text
    return {
      kind: 'selection',
      fromLine: fromLine as number,
      toLine: toLine as number,
      text: cappedText,
      truncated: truncated === true || cappedText !== text
    }
  }

  return { kind: 'none' }
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
