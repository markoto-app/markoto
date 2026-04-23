// Snapshot of the user's editor state at the moment they submit an AI
// prompt. Sent to `/api/ai/prompt` alongside the prompt text so the model
// can resolve "here" / "at my cursor" / "this selection" references to a
// concrete location instead of guessing.
//
// Three states, each with a distinct implication for tool choice:
//   - `none`    — user is not engaged with the doc; AI should ask or
//                 `view_document` and decide based on content.
//   - `cursor`  — user has a caret at a line; `insert_text(insert_line)`
//                 is the obvious default for unqualified "add X" prompts.
//   - `selection` — user has a range selected; `replace_text` (or a
//                   scoped `view_document({ view_range })`) is the
//                   obvious default for "rewrite this" / "fix this".
//
// Lines are 1-indexed to match the `view_document` output format and
// the `insert_line` tool argument.

export type EditorSelectionSnapshot
  = | { kind: 'none' }
    | {
      kind: 'cursor'
      line: number
      column: number
      /**
       * The text of line N with `<CURSOR_IS_HERE>` spliced in at the
       * caret position. Lets the AI split on the marker string to
       * derive `before` + `after` instead of counting characters —
       * LLMs are famously bad at column-offset arithmetic but great
       * at string splitting. If the line was too long to ship in
       * full, this is a window around the cursor with `…` prefixes
       * / suffixes and `lineTruncated: true` — the AI must then
       * `view_document({ view_range: [N, N] })` to recover the
       * exact full line before a `replace_text` call.
       */
      lineText: string
      lineTruncated: boolean
    }
    | { kind: 'selection', fromLine: number, toLine: number, text: string, truncated: boolean }

/**
 * Hard cap on the selection text we ship with the prompt. The AI can
 * always call `view_document({ view_range })` to read the full region;
 * the purpose here is just to give it enough context to understand
 * WHAT the user meant by "this". 400 chars covers a typical paragraph.
 */
export const EDITOR_SELECTION_TEXT_MAX = 400

/**
 * Literal marker spliced into the cursor's line so the model can see
 * exactly where the caret is inside the text. The matching rules that
 * consume this value (system prompt + sanitization) rely on it being
 * a stable string with no regex-special characters — don't change it
 * without bumping both sides together.
 */
export const CURSOR_MARKER = '<CURSOR_IS_HERE>'

/**
 * Max chars of context to include on EACH side of the cursor in the
 * line text. For short lines the full line ships untruncated; for
 * long lines we window around the caret.
 */
export const EDITOR_CURSOR_LINE_CONTEXT_EACH_SIDE = 200
