import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import type { AttributedTo } from './billing'
import type { PlanName } from '~~/shared/config/tiers'
import { aiClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
// Node environment needs a WebSocket implementation; 'ws' is a transitive dep of hocuspocus provider
// but may not be auto-picked on Bun/Nitro. We import it explicitly at runtime if needed.

export type AiStatusPhase = 'thinking' | 'tool' | 'editing' | 'done' | 'error'

export interface AiSession {
  ydoc: Y.Doc
  ytext: Y.Text
  ymeta: Y.Map<unknown>
  awareness: Awareness
  provider: HocuspocusProvider
  sessionId: string
  docId: string
  /**
   * User id of whoever kicked off the session. Tools that write to
   * audited tables (e.g. `uploads.uploaderId` from `generate_image`)
   * attribute to this id rather than the AI's synthetic `ai:assistant:*`
   * principal, so activity logs stay human-readable.
   */
  initiatorUserId: number
  /**
   * Workspace the parent document belongs to, if any. Resolved once at
   * session-open time so the knowledge-base tools don't re-query every
   * call. `null` for standalone / anonymous docs — those sessions don't
   * have `search_knowledge` / `get_knowledge_file` exposed in the first
   * place, but the field is read defensively inside the handlers too.
   */
  workspaceId: string | null
  /**
   * Billing target for this session. `user:{id}` when self-billing,
   * `workspace:{id}` when a `(+)` workspace's owner covers the cost.
   * Resolved once at session open via `resolveBillingContext`. Tool
   * handlers use this directly instead of re-resolving — membership
   * can drift mid-session, but the billing target is frozen at open.
   */
  attributedTo: AttributedTo
  /** Plan that applies to the session. Same freeze-at-open rule as attributedTo. */
  plan: PlanName
  /**
   * Billing-period start frozen at session-open. Every charge for
   * this session lands on the same `ai_usage_period` row via this
   * anchor. Paid users: Stripe anniversary. Free: calendar-month UTC.
   */
  periodStart: Date
  updateStatus(phase: AiStatusPhase, message?: string): void
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
  /**
   * When the session was triggered by an `@ai` mention in a comment
   * thread, the thread's id rides on awareness so all clients can show
   * a "AI is working on this thread" indicator on the matching comment
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
}

/**
 * Connects to Hocuspocus as "AI Assistant" — the AI's own Y.js client.
 * Awareness advertises the AI identity + initiator + live status so the UI
 * can render a distinct avatar and show what the AI is doing. The display
 * name is deliberately vendor-neutral ("AI Assistant") so swapping the
 * underlying model provider is a config change, not a UI rename.
 */
export async function createAiSession(
  docId: string,
  meta: SessionMeta,
  signal: AbortSignal
): Promise<AiSession> {
  const config = useRuntimeConfig()
  if (!config.jwtSecret) {
    throw new Error('JWT secret not configured')
  }
  if (!config.syncInternalUrl) {
    throw new Error('syncInternalUrl not configured')
  }

  const payload = {
    docId,
    userId: aiClientUserId(meta.sessionId),
    // Activity-log attribution picks this up via the onChange hook.
    // Always "markoto" — the initiator's name lives in
    // awareness.aiSession for UI display. Internal JWT principal
    // (`ai:assistant:…`) stays unchanged so existing access checks
    // still work.
    userName: 'markoto',
    readOnly: false
  } satisfies SessionJwtPayload
  const token = jwt.sign(
    payload,
    config.jwtSecret,
    // 10m TTL — sessions are sub-minute in practice (5 min hard
    // deadline; sweeper kills at 7 min). 1h was an overhang that
    // gave a leaked AI-session token a usable replay window long
    // after the session ended; 10m keeps it tight while still
    // covering pathological loops near the prompt deadline.
    { expiresIn: '10m' }
  )

  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  // Set identity BEFORE connecting so the first sync carries it.
  awareness.setLocalStateField('user', {
    name: 'markoto',
    color: meta.initiatorColor,
    isAI: true
  })
  awareness.setLocalStateField('aiSession', {
    sessionId: meta.sessionId,
    initiatorName: meta.initiatorName,
    initiatorUserId: meta.initiatorUserId,
    prompt: meta.prompt,
    // Only included when present — keeps the awareness payload small
    // for the common (non-comment-trigger) case.
    ...(meta.commentThreadId ? { commentThreadId: meta.commentThreadId } : {})
  })
  awareness.setLocalStateField('aiStatus', { phase: 'thinking', message: null })

  // Hocuspocus needs a WebSocket URL. syncInternalUrl is configured as http:// for
  // HTTP calls (like /internal/notify-deleted); convert to ws:// for the WebSocket.
  const wsUrl = config.syncInternalUrl.replace(/^http(s?):\/\//, 'ws$1://')
  console.log(`[aiClient] Connecting to ${wsUrl} as session ${meta.sessionId} for doc ${docId}`)

  let syncResolved = false
  let resolveSync!: () => void
  let rejectSync!: (e: Error) => void
  const syncReady = new Promise<void>((resolve, reject) => {
    resolveSync = resolve
    rejectSync = reject
  })
  const timer = setTimeout(() => {
    if (!syncResolved) {
      syncResolved = true
      rejectSync(new Error('Sync timeout (10s)'))
    }
  }, 10_000)

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docId,
    document: ydoc,
    awareness,
    token,
    onOpen: () => console.log(`[aiClient] open ${meta.sessionId}`),
    onConnect: () => console.log(`[aiClient] connected ${meta.sessionId}`),
    onSynced: () => {
      if (syncResolved) return
      syncResolved = true
      clearTimeout(timer)
      console.log(`[aiClient] synced ${meta.sessionId}`)
      resolveSync()
    },
    onAuthenticationFailed: (data) => {
      if (syncResolved) return
      syncResolved = true
      clearTimeout(timer)
      console.error(`[aiClient] auth failed ${meta.sessionId}:`, data?.reason)
      rejectSync(new Error('Sync authentication failed: ' + (data?.reason || 'unknown')))
    },
    onClose: (data) => {
      const evt = (data as { event?: { code?: number, reason?: string } })?.event
      console.log(`[aiClient] close ${meta.sessionId}:`, evt?.code, evt?.reason)
      if (!syncResolved) {
        syncResolved = true
        clearTimeout(timer)
        rejectSync(new Error(`Connection closed: ${evt?.code} ${evt?.reason || ''}`))
      }
    }
  })

  signal.addEventListener('abort', () => {
    if (syncResolved) return
    syncResolved = true
    clearTimeout(timer)
    rejectSync(new Error('Aborted before sync'))
  }, { once: true })

  await syncReady

  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap<unknown>('meta')

  const updateStatus = (phase: AiStatusPhase, message?: string) => {
    awareness.setLocalStateField('aiStatus', { phase, message: message ?? null })
  }

  const destroy = async () => {
    // Each teardown step is wrapped individually because they can fail
    // independently — awareness set can throw after provider destroy, provider
    // disconnect can throw if the WS already dropped, etc. We want the full
    // sequence to run regardless.
    try {
      awareness.setLocalState(null) // broadcast disappearance
    } catch { /* best-effort */ }
    try {
      provider.disconnect()
    } catch { /* best-effort */ }
    try {
      provider.destroy()
    } catch { /* best-effort */ }
    try {
      ydoc.destroy()
    } catch { /* best-effort */ }
  }

  return {
    ydoc,
    ytext,
    ymeta,
    awareness,
    provider,
    sessionId: meta.sessionId,
    docId,
    initiatorUserId: meta.initiatorUserId,
    workspaceId: meta.workspaceId ?? null,
    attributedTo: meta.attributedTo,
    plan: meta.plan,
    periodStart: meta.periodStart,
    updateStatus,
    destroy
  }
}
