import { createHash } from 'node:crypto'

/**
 * Edit-progress tracking for the agentic loop.
 *
 * Mistral at temperature 0 does not always know when it is finished.
 * After making the requested edit it kept calling tools — swapping a
 * sentence back and forth, inserting bare newlines, replacing text
 * with itself — until the 20-turn limit ended the session with an
 * error. This module classifies each document edit by its effect on
 * the text so the loop can (a) tell the model plainly that an edit
 * achieved nothing and (b) end a session that keeps stalling with a
 * normal "done" instead of running into the turn limit.
 *
 * Pure: the loop passes in the document text before and after each
 * edit tool call; nothing here touches Y.js.
 */

/** Tools that change the current document's text. */
export const DOC_EDIT_TOOLS: ReadonlySet<string> = new Set(['replace_text', 'insert_text'])

/**
 * Prefix of the tool error `replace_text` returns for `old_str === new_str`.
 * Shared with the handler (`aiToolAdapter.ts`) so the loop can count the
 * rejection as a stalled edit without parsing free text.
 */
export const NO_OP_EDIT_ERROR_PREFIX = 'Error: No change'

/**
 * Consecutive stalled turns after which the loop ends the session.
 * A turn is stalled when it made document edits and none of them
 * changed the text's words (see `classifyEdit`).
 */
export const STALLED_TURN_LIMIT = 3

/**
 * - `progress`        — the words of the document changed to a state not seen before
 * - `no-change`       — the text is identical afterwards (incl. the rejected old_str === new_str)
 * - `whitespace-only` — only spaces / line breaks / blank lines changed
 * - `revert`          — the text is back to a state it already had in this session
 * - `repeat`          — the exact same edit call failed before in this session and failed again
 */
export type EditVerdict = 'progress' | 'no-change' | 'whitespace-only' | 'revert' | 'repeat'

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** Classify one edit. `seen` holds fingerprints of earlier states of the document. */
export function classifyEdit(before: string, after: string, seen: ReadonlySet<string>): EditVerdict {
  if (before === after) return 'no-change'
  if (seen.has(fingerprint(after))) return 'revert'
  if (collapseWhitespace(before) === collapseWhitespace(after)) return 'whitespace-only'
  return 'progress'
}

/**
 * Text appended to a stalled edit's tool result. Plain instructions: the
 * model reads tool results, so this is where it learns that it is done.
 */
export function stalledEditNote(verdict: EditVerdict): string | null {
  switch (verdict) {
    case 'no-change':
      return 'Note: the document did not change. Do not repeat this call. If the user\'s request is done, finish now: reply without calling any tool.'
    case 'whitespace-only':
      return 'Note: this edit only changed spaces, line breaks or blank lines. Markdown already separates blocks with one blank line — do not keep adjusting spacing. If the user\'s request is done, finish now: reply without calling any tool.'
    case 'revert':
      return 'Note: the document is now exactly as it was earlier in this session — you are undoing your own edits. Stop editing. If the user\'s request is done, finish now: reply without calling any tool.'
    case 'repeat':
      return 'Note: you already made this exact call and it failed the same way. Do not repeat it. Only text shown by view_document is in the document — the document context and conversation history are not. If the user\'s request is done, finish now: reply without calling any tool.'
    default:
      return null
  }
}

export interface TurnProgress {
  /** True when this turn made edits and none of them was progress. */
  stalled: boolean
  /** Stalled turns in a row, including this one. */
  consecutiveStalledTurns: number
  /** True once `consecutiveStalledTurns` reaches `STALLED_TURN_LIMIT`. */
  shouldStop: boolean
}

/**
 * Per-session tracker. Feed it every document edit with `noteEdit`, then
 * call `endTurn` once per model turn. Turns without document edits
 * (reading, comments, theme) neither count as stalled nor reset the
 * streak — a `view_document` between two pointless edits is still a
 * stall.
 */
export class EditProgressTracker {
  private readonly seen = new Set<string>()
  private readonly failedCalls = new Set<string>()
  private turnVerdicts: EditVerdict[] = []
  private consecutiveStalled = 0

  constructor(initialText: string | null) {
    if (initialText !== null) this.seen.add(fingerprint(initialText))
  }

  /**
   * Record one edit tool call. `before` / `after` are the document text
   * around the call (null when unreadable). `rejectedNoOp` marks the
   * handler's old_str === new_str rejection. `call` identifies the call
   * (tool name + arguments): a failed edit (no match, bad line) is not
   * classified the first time — the error tells the model what went
   * wrong and it usually recovers — but the identical call failing again
   * is a `repeat`.
   *
   * Returns the verdict, or null when the edit was not classified.
   */
  noteEdit(
    before: string | null,
    after: string | null,
    outcome: { isError: boolean, rejectedNoOp: boolean, call: string }
  ): EditVerdict | null {
    let verdict: EditVerdict | null = null
    if (outcome.rejectedNoOp) {
      verdict = 'no-change'
    } else if (outcome.isError) {
      if (this.failedCalls.has(outcome.call)) verdict = 'repeat'
      else this.failedCalls.add(outcome.call)
    } else if (before !== null && after !== null) {
      // Someone else's edit between our snapshots is part of "before":
      // only this call's effect is judged.
      this.seen.add(fingerprint(before))
      verdict = classifyEdit(before, after, this.seen)
      this.seen.add(fingerprint(after))
    }
    if (verdict) this.turnVerdicts.push(verdict)
    return verdict
  }

  endTurn(): TurnProgress {
    const verdicts = this.turnVerdicts
    this.turnVerdicts = []
    if (verdicts.length === 0) {
      return { stalled: false, consecutiveStalledTurns: this.consecutiveStalled, shouldStop: false }
    }
    const stalled = !verdicts.includes('progress')
    this.consecutiveStalled = stalled ? this.consecutiveStalled + 1 : 0
    return {
      stalled,
      consecutiveStalledTurns: this.consecutiveStalled,
      shouldStop: this.consecutiveStalled >= STALLED_TURN_LIMIT
    }
  }
}
