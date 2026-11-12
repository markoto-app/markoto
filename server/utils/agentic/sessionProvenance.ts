import { markAiSessionProvenanceClean, recordAiSessionProvenance } from '../../repos/aiSessionProvenance'
import { removeAiSession } from '../ai/aiSessions'
import type { CrossBoundaryGuard } from './crossBoundary'
import { useLogger } from '../platform/logger'
import type { DocAccess, UserScope } from '../../repos/proofs'

const log = useLogger('ai-provenance')

// Lifecycle of a session's `ai_session_provenance` row (see the table
// comment in `server/db/schema/ai.ts`), shared by `/api/ai/prompt` and the
// `@ai` comment trigger:
//
//   claim    → row written `clean = false` right after the session is
//              registered, BEFORE the AI client can write anything;
//   finalize → after the AI client has left the document, flip to
//              `clean = true` iff the session's taint gate never fired.
//
// Everything else (crash, error before the guard existed, tainted
// session, a failed update) leaves the row not-clean, so the session's
// edits keep counting as somebody else's text, the taint gate's
// fail-closed polarity.

/**
 * Write the provenance row for a freshly claimed session. If that fails
 * the session is released again and the error propagates: an AI session
 * must never write without a provenance row (its edits would be
 * attributed without the taint information).
 */
export async function recordSessionProvenance(doc: DocAccess<'write'>, initiator: UserScope, sessionId: string): Promise<void> {
  try {
    await recordAiSessionProvenance(doc, sessionId)
  } catch (e) {
    await removeAiSession(initiator, sessionId).catch(() => {})
    throw e
  }
}

/**
 * Mark the session's edits as the invoker's own when the session stayed
 * clean. Call after `aiSession.destroy()`. `guard` is null when the loop
 * never got as far as building it (then the AI wrote nothing either).
 */
export async function finalizeSessionProvenance(doc: DocAccess<'write'>, sessionId: string, guard: CrossBoundaryGuard | null): Promise<void> {
  if (!guard || guard.tainted) return
  try {
    await markAiSessionProvenanceClean(doc, sessionId)
  } catch (e) {
    // Fail closed: the edits stay "foreign", at worst a later session
    // asks before reaching other documents.
    log.warn('could not mark session clean', { sessionId, err: e })
  }
}
