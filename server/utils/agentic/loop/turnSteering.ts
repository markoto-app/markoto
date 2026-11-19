import { POST_JOB_READ_TURNS, READ_STREAK_NOTE_TURNS, STEP_RESERVE_TURNS } from '../limits'

// Turn-level steering of a session that spends its steps reading. Three
// rules, evaluated after every work turn:
//
// - A run of turns that only read gets a note (every READ_STREAK_NOTE_TURNS
//   turns): act on what was read, or hand a rule-like bulk change to
//   `delegate_rewrite` instead of reading every section first.
// - With STEP_RESERVE_TURNS turns left the model is told once how many
//   steps remain and to finish, so the turn limit does not land in the
//   middle of the work.
// - After a delegated job of this session finished or went to the
//   background, the job's report is the result: at most POST_JOB_READ_TURNS
//   reading turns follow (a look at flagged parts), then the loop closes
//   with the answer (`wrapUp.ts`, reason `job-settled`).
//
// Without them, live sessions of a large translation ran into the turn
// limit two ways: the planner read sections for 18 turns after a scan and
// never created the job, or the job translated twelve parts and the
// planner then re-read every translated chapter.

/** Tools that only read the document (or other documents) and change nothing. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'view_document',
  'read_section',
  'outline',
  'search_document',
  'read_comments',
  'view_other_document'
])

/** A job this session started that no longer needs the planner: finished, or running in the background. */
export type SettledJobStatus = 'finished' | 'running'

export interface TurnSteeringResult {
  /** Appended to the turn's tool results as a text part; null when nothing to say. */
  note: string | null
  /** The session should close now with its answer (`wrapUp.ts`, reason `job-settled`). */
  closeForJob: boolean
}

export interface TurnSteeringInput {
  /** Names of the tool calls the turn made. */
  calls: readonly string[]
  /** 1-based number of the turn that just ran. */
  turn: number
  maxTurns: number
  /** `delegate_rewrite` is offered in this session. */
  canDelegate: boolean
  /** The tool that answers the user: `message_to_user`, or `reply_to_comment` in a comment session. */
  answerTool: string
}

function isReadOnlyTurn(calls: readonly string[]): boolean {
  return calls.length > 0 && calls.every(name => READ_ONLY_TOOLS.has(name))
}

function readStreakNote(streak: number, left: number, canDelegate: boolean): string {
  const delegate = canDelegate
    ? ' For one rule-like change over many sections (translate, change tone, terminology), call delegate_rewrite now: its workers read each part, so you do not need to read the sections first.'
    : ''
  return `Note: the last ${streak} steps only read the document, and ${left} steps are left in this session.${delegate} Otherwise act on what you have read now; when you still need text, read several sections in one step.`
}

function reserveNote(left: number, answerTool: string): string {
  return `Note: ${left} steps are left before this session stops. Use them to finish the task (make the edit, start the job) and then answer the user with ${answerTool}. Do not spend them reading.`
}

export class TurnSteering {
  /** Turns in a row that only read. */
  private readStreak = 0
  private reserveNoted = false
  /** The job this session settled, and in which turn. */
  private settled: { status: SettledJobStatus, turn: number } | null = null
  /** Reading turns after the job settled. */
  private postJobReads = 0

  /** A delegated job of this session finished or went to the background in `turn`. */
  noteJob(status: SettledJobStatus, turn: number): void {
    this.settled = { status, turn }
    this.postJobReads = 0
  }

  /** The job this session settled, if any. */
  get settledJob(): SettledJobStatus | null {
    return this.settled?.status ?? null
  }

  /** Account for one finished work turn; the note to append and whether the session should close. */
  endTurn(input: TurnSteeringInput): TurnSteeringResult {
    const readOnly = isReadOnlyTurn(input.calls)
    this.readStreak = readOnly ? this.readStreak + 1 : 0
    const left = input.maxTurns - input.turn

    if (this.settled && input.turn > this.settled.turn && readOnly) {
      this.postJobReads += 1
      if (this.postJobReads >= POST_JOB_READ_TURNS) return { note: null, closeForJob: true }
    }

    // The last turn: the closing turn follows with its own instruction.
    if (left <= 0) return { note: null, closeForJob: false }
    const notes: string[] = []
    if (!this.settled && readOnly && this.readStreak % READ_STREAK_NOTE_TURNS === 0) {
      notes.push(readStreakNote(this.readStreak, left, input.canDelegate))
    }
    if (!this.reserveNoted && left <= STEP_RESERVE_TURNS) {
      this.reserveNoted = true
      notes.push(reserveNote(left, input.answerTool))
    }
    return { note: notes.length > 0 ? notes.join('\n') : null, closeForJob: false }
  }
}
