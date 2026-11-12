import { appendActivity, pruneActivity, type ActivityMetadata } from '../../../repos/activity'
import { aiClientUserId } from '~~/shared/contracts/jwt'
import type { DocAccess } from '../../../repos/proofs'
import { docExists } from '../../../repos/documents'
import { findTool } from '../../ai/tools/registry'
import { useLogger } from '../../platform/logger'
import type { LoopContext } from './loopContext'

const loopLog = useLogger('ai-loop')

/**
 * Emit an `ai.tool` activity row for a meta-tool the AI just used.
 * Limited to tools that don't surface in the Y.Doc state and would
 * otherwise be invisible to collaborators (web_search, fetch_url,
 * generate_image, etc.). Doc-mutating tools bubble through sync-server
 * and emit their own activity events.
 *
 * Fire-and-forget: failures must never block the agentic loop.
 */
export async function logAiTool(
  doc: DocAccess<'write'>,
  sessionId: string,
  metadata: Extract<ActivityMetadata, { kind: 'ai.tool' }>
): Promise<void> {
  try {
    if (!(await docExists(doc.docId))) return
    await appendActivity(doc, {
      userName: 'AI Assistant',
      // Carries the synthetic principal so the activity-feed
      // enrichment join can resolve back to the human initiator
      // through `ai_sessions.session_id = sessionId`. Without this,
      // the row would be indistinguishable from a deleted-user edit
      // `user_id=NULL`, `user_name='AI Assistant'`, no traceback.
      actorPrincipal: aiClientUserId(sessionId),
      action: 'ai.tool',
      metadata
    })
    await pruneActivity(doc)
  } catch (e) {
    loopLog.warn('ai.tool activity log failed', { err: e })
  }
}

/**
 * Surface meta-tools (search/fetch already logged inline by the web
 * sub-calls) to the activity feed so the AI's reads/searches show in the
 * row stream. Which tools, and what their row carries, is the tool's
 * `activity` in the registry; view_document and read_comments have none
 * (pure noise: AI reads doc state every turn).
 */
export function logToolActivity(ctx: LoopContext, name: string, validatedArgs: unknown): void {
  const activity = findTool(name)?.activity
  if (!activity) return
  void logAiTool(ctx.opts.aiSession.docAccess, ctx.opts.aiSession.sessionId, activity(validatedArgs))
}
