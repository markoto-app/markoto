import jwt from 'jsonwebtoken'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { AttributedTo } from '../billing/billing'
import type { PlanName } from '~~/shared/config/tiers'
import { aiClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
import { checkout, release, type PoolEntry } from '../mcp/yDocPool'
import type { ToolContext, ToolStatusPhase } from '../agentic/toolContext'
import { aiStatus, toStatusLine, type AiStatusInput } from '~~/shared/ai/statusSteps'
import type { JobConfirmationDetails } from '~~/shared/ai/jobConfirmation'
import type { ReplaceConfirmationDetails } from '~~/shared/ai/replaceConfirmation'
import type { ResolvedAiProviders } from '../aiProviders/resolve'
import type { AiSessionChannel } from '../agentic/sessionChannel'
import { useEnv } from '~~/shared/env/load'
import type { DocAccess, UserScope, WorkspaceAccess } from '../../repos/proofs'

// AiSession = ToolContext + the loop-only lifecycle plumbing the
// runLoop needs (`provider` for telemetry, `destroy()` for the
// finally-block teardown). Tool handlers see only the `ToolContext`
// surface: see `server/utils/agentic/toolContext.ts` for the rationale.
export interface AiSession extends ToolContext {
  /** In-app sessions are only opened with write access (prompt route, `@ai` trigger). */
  docAccess: DocAccess<'write'>
  provider: HocuspocusProvider
  /** Initiator-only channel: prompt, status messages, answers, confirmations. */
  channel: AiSessionChannel
  destroy(): Promise<void>
}

export interface SessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  initiatorColor: string
  /**
   * Initiator-only channel for this session. The prompt, status
   * messages and answers go here, never into awareness, which every
   * participant of the document receives.
   */
  channel: AiSessionChannel
  /** Workspace the doc belongs to, forwarded to the resulting AiSession. */
  workspaceId?: string | null
  /** The proofs the session's tools act under (see `MetaToolContext`). */
  docAccess: DocAccess<'write'>
  self: UserScope
  workspaceAccess: WorkspaceAccess<'member'> | null
  /** Billing attribution target, resolved by the caller. */
  attributedTo: AttributedTo
  /** Plan that applies to the session. */
  plan: PlanName
  /** Billing-period start (Stripe anniversary for paid, calendar month for free). */
  periodStart: Date
  /** LiteLLM virtual-key bearer token resolved at session open. */
  virtualKey: string
  /** BYOK / instance-default AI providers resolved at session open. */
  aiProviders: ResolvedAiProviders
  /**
   * When the session was triggered by an `@ai` mention in a comment
   * thread, the thread's id rides on awareness so all clients can show
   * a "AI is working on this thread" indicator on the matching comment
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
  /** When the session is aborted (epoch ms), for tools that wait (`sessionDeadlineAt`). */
  deadlineAt?: number
}

/**
 * Mint the loop's Hocuspocus JWT. Synthetic principal
 * `ai:assistant:{sessionId}` for activity-log attribution; 10m TTL,
 * tight enough to limit replay if leaked, generous enough to cover the
 * 5-min prompt deadline plus salvage paths.
 */
function mintLoopJwt(docId: string, sessionId: string): string {
  const env = useEnv()
  if (!env.auth.jwtSecret) throw new Error('JWT secret not configured')
  const payload: SessionJwtPayload = {
    docId,
    userId: aiClientUserId(sessionId),
    // Activity-log attribution picks this up via the onChange hook.
    // Always "markoto": initiator's name lives in awareness.aiSession
    // for UI display.
    userName: 'markoto',
    readOnly: false
  }
  return jwt.sign(payload, env.auth.jwtSecret, { expiresIn: '10m' })
}

/**
 * Connects to Hocuspocus as "markoto", the AI's own Y.js client.
 * Awareness advertises ONLY what every participant may see: the AI
 * identity, who started the session, the coarse phase and (for `@ai`
 * comment sessions) the thread id, enough for "markoto is working for
 * Alice". The prompt, status messages and answers go to the initiator
 * through `meta.channel`. The display name is deliberately
 * vendor-neutral ("markoto") so swapping the underlying model provider
 * is a config change, not a UI rename.
 *
 * Implementation: routes through `yDocPool.checkout` with principalId
 * `loop:{sessionId}`. Each loop run has a unique session id so this is
 * always a fresh checkout (no cache hits), but going through the pool
 * keeps the connection lifecycle in one place and lets the MCP wrapper
 * use the exact same primitive.
 */
export async function createAiSession(
  docId: string,
  meta: SessionMeta,
  signal: AbortSignal
): Promise<AiSession> {
  const env = useEnv()

  // Convert http(s):// → ws(s):// for Hocuspocus.
  const syncUrl = env.sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://')
  const principalId = `loop:${meta.sessionId}`
  const key = { docId, principalId }

  // Race the checkout against an external abort (request cancelled
  // before sync completed). The pool's own 10s sync timeout is the
  // other terminating condition.
  const checkoutPromise = checkout(key, {
    jwt: () => mintLoopJwt(docId, meta.sessionId),
    awarenessUser: {
      name: 'markoto',
      color: meta.initiatorColor,
      isAI: true
    },
    awarenessExtra: {
      aiSession: {
        sessionId: meta.sessionId,
        initiatorName: meta.initiatorName,
        initiatorUserId: meta.initiatorUserId,
        // Only included when present, keeps the awareness payload
        // small for the common (non-comment-trigger) case.
        ...(meta.commentThreadId ? { commentThreadId: meta.commentThreadId } : {})
      },
      aiStatus: { phase: 'thinking', message: null }
    },
    syncUrl
  })

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted before sync'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('Aborted before sync')), { once: true })
  })

  let entry: PoolEntry
  try {
    entry = await Promise.race([checkoutPromise, abortPromise])
  } catch (err) {
    // If the abort fired before the pool entry was returned, but the
    // pool checkout still completes later, release it so it can be
    // idle-evicted instead of pinned forever. The race winner doesn't
    // know about the loser, fire-and-forget cleanup.
    void checkoutPromise.then(
      e => release(e.key),
      () => undefined
    )
    throw err
  }

  // Status: the phase alone goes to awareness (everyone sees "markoto
  // is working"); the message ("Reading 'Q3 plan'…", URLs, queries) goes
  // to the initiator's channel only. Awareness is only touched when the
  // phase changes.
  let broadcastPhase: ToolStatusPhase = 'thinking'
  const updateStatus = (phase: ToolStatusPhase, status?: AiStatusInput): void => {
    if (phase !== broadcastPhase) {
      broadcastPhase = phase
      entry.awareness.setLocalStateField('aiStatus', { phase, message: null })
    }
    const line = toStatusLine(status)
    void meta.channel.setStatus({ phase, message: line?.text ?? null, step: line?.step ?? null })
  }

  const deliverResponse = (response: { message: string, isQuestion: boolean, ts: number }): void => {
    void meta.channel.setResponse(response)
  }

  // A delegated job's cost confirmation: same initiator-only round trip as
  // the taint gate (deny / timeout / error = not allowed).
  const confirmJob = (details: JobConfirmationDetails) => {
    updateStatus('tool', aiStatus('waitingConfirmation'))
    return meta.channel.requestConfirmation({ tool: 'delegate_rewrite', target: null, kind: 'job', job: details }, signal)
  }

  // A large replace_all: the user sees the count and the word forms first.
  const confirmReplace = (details: ReplaceConfirmationDetails) => {
    updateStatus('tool', aiStatus('waitingConfirmation'))
    return meta.channel.requestConfirmation({ tool: 'replace_all', target: null, kind: 'replace', replace: details }, signal)
  }

  const destroy = async (): Promise<void> => {
    // Broadcast the AI's disappearance before releasing, collaborators
    // see the avatar drop immediately rather than waiting for idle
    // eviction.
    try {
      entry.awareness.setLocalState(null)
    } catch { /* best-effort */ }
    release(key)
    // Sweeper closes the entry IDLE_MS after release. We don't force
    // close here because:
    //   - Multiple checkouts on the same key (in flight from concurrent
    //     features that share the principal) shouldn't be torn down by
    //     one consumer's destroy.
    //   - Idle eviction is the canonical close path; respecting it here
    //     keeps the API symmetric.
  }

  return {
    docId,
    initiatorUserId: meta.initiatorUserId,
    workspaceId: meta.workspaceId ?? null,
    self: meta.self,
    docAccess: meta.docAccess,
    workspaceAccess: meta.workspaceAccess,
    ydoc: entry.ydoc,
    ytext: entry.ytext,
    ymeta: entry.ymeta,
    awareness: entry.awareness,
    sessionId: meta.sessionId,
    attributedTo: meta.attributedTo,
    plan: meta.plan,
    periodStart: meta.periodStart,
    virtualKey: meta.virtualKey,
    aiProviders: meta.aiProviders,
    updateStatus,
    deliverResponse,
    confirmJob,
    confirmReplace,
    sessionDeadlineAt: meta.deadlineAt,
    sessionSignal: signal,
    channel: meta.channel,
    provider: entry.provider,
    destroy
  }
}
