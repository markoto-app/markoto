import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import type { Awareness } from 'y-protocols/awareness'
import { isReauthClose, syncRejectionFromClose, type SyncCloseReason } from '~~/shared/contracts/syncClose'

/**
 * Minimal shape the composable needs from a "provider". Real
 * HocuspocusProvider satisfies this; tests can inject a fake with the
 * same surface without having to mock the WebSocket stack.
 */
export interface ProviderLike {
  destroy(): void
  /** Close the socket and stop reconnecting (HocuspocusProvider has it;
   *  optional so minimal test fakes don't need it). */
  disconnect?(): void
}

/**
 * Owns the Hocuspocus provider lifecycle, WebSocket connect, reconnect,
 * disconnect, and the `status` / `synced` / `userCount` / `docSizeBytes`
 * reactivity derived from provider events.
 *
 * A deliberately dumb transport layer: it knows nothing about access mode,
 * passwords, ownership or Y.Doc contents. The orchestrator (`useDocument`)
 * calls `connect()` at the right moment (never for forbidden or
 * password-gated docs before verification).
 */

export interface HocuspocusSyncOptions {
  docId: string
  ydoc: Y.Doc
  awareness: Awareness
  syncUrl: string
  /** Reads the JWT for a (re)connection. Passed straight to
   *  HocuspocusProvider's `token` option, which invokes it on EVERY
   *  (re)connect: so returning a value that reflects the current token
   *  (and refreshes it when near expiry) is what keeps a long-lived
   *  session's reconnect from presenting a dead JWT. May be async. The
   *  token changes over the doc's lifetime (anonymous → password-verified
   *  → refreshed), so it must be read lazily.
   *  `renewal` is true when the sync server asked for a fresh token on the
   *  open connection (shortly before the current one expires). */
  getToken: (opts: { renewal: boolean }) => string | Promise<string>
  /** The sync server closed the connection for re-authentication; the
   *  provider reconnects by itself, the caller makes sure that reconnect
   *  presents a freshly fetched token. */
  onReauthRequired?: () => void
  /** Fires on every successful sync (initial load + later reconnects). */
  onSynced?: () => void
  /** Fires on disconnect; receives whether this provider ever synced, to
   *  tell "server offline" from "lost after first sync". The caller must NOT
   *  seed doc content from here: before any sync the server's content is
   *  unknown, and a local seed would merge with it on auto-reconnect. Seed
   *  from `onSynced` only. */
  onDisconnect?: (everSynced: boolean) => void
  /** Hocuspocus rejected the JWT, caller should flip `isReadOnly`. */
  onAuthFailed?: () => void
  /**
   * Factory for the underlying provider. Defaults to a real
   * HocuspocusProvider; tests inject a fake that captures the config so
   * they can fire the lifecycle callbacks without WebSockets.
   */
  providerFactory?: (config: HocuspocusProviderConfiguration) => ProviderLike
}

export function useHocuspocusSync(opts: HocuspocusSyncOptions) {
  // shallowRef: a `ref` would Proxy-wrap the provider and break reference
  // comparisons by anyone holding `.value`.
  const provider = shallowRef<ProviderLike | null>(null)
  const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const synced = ref(false)
  const userCount = ref(1)
  const docSizeBytes = ref(0)
  // Set when the sync server refused an update (too large, invalid setting…).
  // A reconnect would resend the same state, so the provider stops and the
  // editor asks the user to reload.
  const syncRejection = ref<SyncCloseReason | null>(null)

  function isAuthenticated(): boolean {
    return (provider.value as { isAuthenticated?: unknown } | null)?.isAuthenticated === true
  }

  function stopReconnecting() {
    provider.value?.disconnect?.()
    status.value = 'disconnected'
  }

  const makeProvider = opts.providerFactory
    ?? ((config: HocuspocusProviderConfiguration) => new HocuspocusProvider(config))

  function connect() {
    // No sync URL (pure-offline dev): report "synced, disconnected" so the
    // editor still renders; the caller seeds via `onSynced`.
    if (!opts.syncUrl) {
      status.value = 'disconnected'
      synced.value = true
      opts.onSynced?.()
      return
    }

    provider.value = makeProvider({
      url: opts.syncUrl,
      name: opts.docId,
      document: opts.ydoc,
      awareness: opts.awareness,
      // An accessor, not a string: it is called on every (re)connect, so a
      // token refreshed near expiry keeps reconnects authenticated.
      // `Promise.resolve` normalises sync/async to the provider's shape.
      // An authenticated provider asking for a token is answering the
      // server's renewal request; on a (re)connect it has already reset
      // `isAuthenticated`.
      token: () => Promise.resolve(opts.getToken({ renewal: isAuthenticated() })),
      onConnect: () => { status.value = 'connected' },
      onDisconnect: () => {
        status.value = 'disconnected'
        opts.onDisconnect?.(synced.value)
      },
      onSynced: () => {
        synced.value = true
        docSizeBytes.value = Y.encodeStateAsUpdate(opts.ydoc).byteLength
        opts.onSynced?.()
      },
      onAuthenticationFailed: () => { opts.onAuthFailed?.() },
      onClose: ({ event }) => {
        if (isReauthClose(event)) {
          opts.onReauthRequired?.()
          return
        }
        const rejection = syncRejectionFromClose(event)
        if (!rejection) return
        syncRejection.value = rejection
        stopReconnecting()
      },
      // A socket-level close (oversized frame, code 1009) has already
      // scheduled a reconnect inside the provider by the time `onClose`
      // runs; cut that attempt off as soon as it starts.
      onStatus: ({ status: next }) => {
        if (syncRejection.value && next === WebSocketStatus.Connecting) stopReconnecting()
      },
      onAwarenessChange: ({ states }) => {
        // Dedup by `user.id` so several tabs of the same person count once,
        // matching what PresenceBar shows. Anonymous editors (no id) and AI
        // sessions count once per socket: anon tabs can't be told apart and
        // each AI session is distinct.
        //
        // Real ids are numeric (DB-issued); 'anonymous' is the only legitimate
        // string. A numeric string still dedups via Number coercion, but
        // signals a regression at a JWT mint site or session helper, so it is logged.
        const seenUserIds = new Set<number>()
        let unique = 0
        for (const s of states) {
          const u = (s as { user?: { id?: number | string | null, isAI?: boolean } }).user
          if (!u) continue
          if (u.isAI) {
            unique++
            continue
          }
          const id = u.id
          if (id === null || id === undefined || id === 'anonymous') {
            unique++
            continue
          }
          let numericId: number
          if (typeof id === 'number') {
            numericId = id
          } else {
            // Non-numeric: log and count as anonymous rather than crash the chip.
            const parsed = Number(id)
            if (!Number.isFinite(parsed)) {
              console.warn('[useHocuspocusSync] non-numeric user.id slipped into awareness:', id)
              unique++
              continue
            }
            console.warn('[useHocuspocusSync] string-numeric user.id slipped into awareness (expected number):', id)
            numericId = parsed
          }
          if (seenUserIds.has(numericId)) continue
          seenUserIds.add(numericId)
          unique++
        }
        userCount.value = unique
      }
    })
  }

  function disconnect() {
    provider.value?.destroy()
    provider.value = null
  }

  /**
   * Replaces the provider wholesale; used after a password-verified token
   * swap, since the old provider carries a rejected or absent token.
   */
  function reconnect() {
    disconnect()
    // So the next `onSynced` re-runs the template-seed / clear-pending-unlock branches.
    synced.value = false
    syncRejection.value = null
    status.value = 'connecting'
    connect()
  }

  function destroy() {
    disconnect()
  }

  return {
    provider,
    status,
    synced,
    userCount,
    docSizeBytes,
    syncRejection,
    connect,
    disconnect,
    reconnect,
    destroy
  }
}
