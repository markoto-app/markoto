import jwt from 'jsonwebtoken'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { AttributedTo } from './billing'
import type { PlanName } from '~~/shared/config/tiers'
import { aiClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
import { checkout, release, type PoolEntry } from './yDocPool'
import type { ToolContext, ToolStatusPhase } from './agentic/toolContext'
import type { ResolvedAiProviders } from './aiProviders/resolve'

// Re-export for callers that still import `AiStatusPhase` from this
// module. Going forward they should import `ToolStatusPhase` from
// `./agentic/toolContext` directly.
export type AiStatusPhase = ToolStatusPhase

// AiSession = ToolContext + the loop-only lifecycle plumbing the
// runLoop needs (`provider` for telemetry, `destroy()` for the
// finally-block teardown). Tool handlers see only the `ToolContext`
// surface — see `server/utils/agentic/toolContext.ts` for the rationale.
export interface AiSession extends ToolContext {
  provider: HocuspocusProvider
  destroy(): Promise<void>
}

export interface SessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  initiatorColor: string
  prompt: string
  /** Workspace the doc belongs to, forwarded to the resulting AiSession. */
  workspaceId?: string | null
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
}

/**
 * Mint the loop's Hocuspocus JWT. Synthetic principal
 * `ai:assistant:{sessionId}` for activity-log attribution; 10m TTL —
 * tight enough to limit replay if leaked, generous enough to cover the
 * 5-min prompt deadline plus salvage paths.
 */
function mintLoopJwt(docId: string, sessionId: string): string {
  const config = useRuntimeConfig()
  if (!config.jwtSecret) throw new Error('JWT secret not configured')
  const payload: SessionJwtPayload = {
    docId,
    userId: aiClientUserId(sessionId),
    // Activity-log attribution picks this up via the onChange hook.
    // Always "markoto" — initiator's name lives in awareness.aiSession
    // for UI display.
    userName: 'markoto',
    readOnly: false
  }
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '10m' })
}

/**
 * Connects to Hocuspocus as "AI Assistant" — the AI's own Y.js client.
 * Awareness advertises the AI identity + initiator + live status so the
 * UI can render a distinct avatar and show what the AI is doing. The
 * display name is deliberately vendor-neutral ("markoto") so swapping
 * the underlying model provider is a config change, not a UI rename.
 *
 * Implementation: routes through `yDocPool.checkout` with principalId
 * `loop:{sessionId}`. Each loop run has a unique session id so this is
 * always a fresh checkout (no cache hits) — but going through the pool
 * keeps the connection lifecycle in one place and lets the MCP wrapper
 * use the exact same primitive.
 */
export async function createAiSession(
  docId: string,
  meta: SessionMeta,
  signal: AbortSignal
): Promise<AiSession> {
  const config = useRuntimeConfig()
  if (!config.syncInternalUrl) throw new Error('syncInternalUrl not configured')

  // Convert http(s):// → ws(s):// for Hocuspocus.
  const syncUrl = config.syncInternalUrl.replace(/^http(s?):\/\//, 'ws$1://')
  const principalId = `loop:${meta.sessionId}`
  const key = { docId, principalId }

  // Race the checkout against an external abort (request cancelled
  // before sync completed). The pool's own 10s sync timeout is the
  // other terminating condition.
  const checkoutPromise = checkout(key, {
    jwt: mintLoopJwt(docId, meta.sessionId),
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
        prompt: meta.prompt,
        // Only included when present — keeps the awareness payload
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
    // know about the loser — fire-and-forget cleanup.
    void checkoutPromise.then(
      e => release(e.key),
      () => undefined
    )
    throw err
  }

  // Loop's `aiStatus` field uses the same awareness slot the legacy
  // `updateStatus` closure wrote to. Handlers continue to call
  // `ctx.updateStatus(...)` and the slot writes show up to other
  // collaborators as before.
  const updateStatus = (phase: ToolStatusPhase, message?: string): void => {
    entry.awareness.setLocalStateField('aiStatus', { phase, message: message ?? null })
  }

  const destroy = async (): Promise<void> => {
    // Broadcast the AI's disappearance before releasing — collaborators
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
    provider: entry.provider,
    destroy
  }
}
