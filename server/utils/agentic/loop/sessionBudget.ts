import { SESSION_INTERACTION_CAP } from '../limits'
import { aiStatus, type AiStatusLine } from '~~/shared/ai/statusSteps'
import { SESSION_TOOL_CALL_CAPS } from '../../ai/tools/registry'

/** The status a session ends with when it hits the interaction cap. */
export function sessionCapStatus(): AiStatusLine {
  return aiStatus('sessionCap', { cap: String(SESSION_INTERACTION_CAP) })
}

/**
 * Per-session SAFETY cap counter. Two-axis:
 *   - `interactions`: total interactions across all turns + sub-calls.
 *     Crossing SESSION_INTERACTION_CAP means runaway loop / prompt-
 *     injection ping-pong; we abort the session via setStatus('error').
 *   - `toolCallCounts`: per-tool ceiling. Crossing returns a TOOL ERROR
 *     so the model can wrap up gracefully (vs aborting the session).
 *
 * Independent of the per-user monthly $ budget, that's LiteLLM's job.
 */
export class SessionBudget {
  private interactions = 0
  private readonly toolCallCounts = new Map<string, number>()

  /**
   * Try to charge `delta` interactions. Returns `{ ok: false, message }`
   * if the cap would be crossed (caller should exit cleanly via the
   * existing setStatus('error') path); `{ ok: true }` otherwise.
   */
  consumeInteractions(delta: number, reason: string, log: (m: string) => void): { ok: true } | { ok: false, message: string } {
    if (this.interactions + delta > SESSION_INTERACTION_CAP) {
      const message = sessionCapStatus().text
      log(`[limits] session interaction cap reached (${this.interactions}+${delta} > ${SESSION_INTERACTION_CAP}); aborting`)
      return { ok: false, message }
    }
    this.interactions += delta
    log(`[runLoop] noted +${delta} (${reason}; session=${this.interactions})`)
    return { ok: true }
  }

  /**
   * Try to claim a tool slot for `name`. Returns false if the tool's
   * cap was already exhausted; true (and increments the slot counter)
   * otherwise. Tools without a configured cap are unlimited.
   */
  claimToolSlot(name: string): boolean {
    const cap = SESSION_TOOL_CALL_CAPS[name]
    if (typeof cap !== 'number') return true
    const used = this.toolCallCounts.get(name) ?? 0
    if (used >= cap) return false
    this.toolCallCounts.set(name, used + 1)
    return true
  }

  toolCap(name: string): number | undefined {
    return SESSION_TOOL_CALL_CAPS[name]
  }

  totalInteractions(): number {
    return this.interactions
  }
}
