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
  updateStatus(phase: AiStatusPhase, message?: string): void
  destroy(): Promise<void>
}

export interface SessionMeta {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  initiatorColor: string
  prompt: string
}

/**
 * Connects to Hocuspocus as "Claude" — the AI's own Y.js client.
 * Awareness advertises the AI identity + initiator + live status so the UI
 * can render a distinct avatar and show what Claude is doing.
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
      userId: `ai:claude:${meta.sessionId}`,
      // Activity log attribution picks this up via the onChange hook. Always
      // "Claude" — the initiator's name lives in awareness.aiSession for UI display.
      userName: 'Claude',
      readOnly: false
    },
    config.jwtSecret,
    { expiresIn: '1h' }
  )

  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  // Set identity BEFORE connecting so the first sync carries it.
  awareness.setLocalStateField('user', {
    name: 'Claude',
    color: meta.initiatorColor,
    isAI: true
  })
  awareness.setLocalStateField('aiSession', {
    sessionId: meta.sessionId,
    initiatorName: meta.initiatorName,
    initiatorUserId: meta.initiatorUserId,
    prompt: meta.prompt
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
    onClose: (data: any) => {
      console.log(`[aiClient] close ${meta.sessionId}:`, data?.event?.code, data?.event?.reason)
      if (!syncResolved) {
        syncResolved = true
        clearTimeout(timer)
        rejectSync(new Error(`Connection closed: ${data?.event?.code} ${data?.event?.reason || ''}`))
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
    try {
      awareness.setLocalState(null) // broadcast disappearance
    } catch {}
    try {
      provider.disconnect()
    } catch {}
    try {
      provider.destroy()
    } catch {}
    try {
      ydoc.destroy()
    } catch {}
  }

  return {
    ydoc,
    ytext,
    ymeta,
    awareness,
    provider,
    sessionId: meta.sessionId,
    updateStatus,
    destroy
  }
}
