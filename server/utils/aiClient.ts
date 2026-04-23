import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
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
  updateStatus(phase: AiStatusPhase, message?: string): void
  destroy(): Promise<void>
}

export interface SessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  initiatorColor: string
  prompt: string
  // 'prompt' = full agentic loop (long-running, gets the bottom bar's
  // attention treatment). 'rewrite' = inline selection rewrite (short,
  // its own UI surface — should NOT animate the bottom bar). Defaults
  // to 'prompt' when omitted.
  kind?: 'prompt' | 'rewrite'
  /** Workspace the doc belongs to, forwarded to the resulting AiSession. */
  workspaceId?: string | null
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

  const token = jwt.sign(
    {
      docId,
      userId: `ai:assistant:${meta.sessionId}`,
      // Activity log attribution picks this up via the onChange hook. Always
      // "AI Assistant" — the initiator's name lives in awareness.aiSession for UI display.
      userName: 'AI Assistant',
      readOnly: false
    },
    config.jwtSecret,
    { expiresIn: '1h' }
  )

  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  // Set identity BEFORE connecting so the first sync carries it.
  awareness.setLocalStateField('user', {
    name: 'AI Assistant',
    color: meta.initiatorColor,
    isAI: true
  })
  awareness.setLocalStateField('aiSession', {
    sessionId: meta.sessionId,
    initiatorName: meta.initiatorName,
    initiatorUserId: meta.initiatorUserId,
    prompt: meta.prompt,
    kind: meta.kind ?? 'prompt'
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
    updateStatus,
    destroy
  }
}
