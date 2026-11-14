import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import type { Awareness } from 'y-protocols/awareness'
import { isReauthClose, isSyncBusyReason, SYNC_CLOSE_REASONS, syncRejectionFromClose, type SyncCloseReason } from '~~/shared/contracts/syncClose'

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

/** `invalid-update` rejections retried with a fresh provider before giving up. */
export const MAX_RESYNC_RETRIES = 3
/** A connection counts as healthy again after this long without a rejection. */
const RESYNC_STABLE_MS = 30_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

/** Exponential backoff with jitter (±25 %), capped at RETRY_MAX_MS. */
export function syncRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.75 + random() * 0.5))
}

/**
 * People present in the document, from the awareness states. Dedup by
 * `user.id` so several tabs of the same person count once, matching what
 * PresenceBar shows.
 */
function countPresentUsers(states: unknown[]): number {
  // Anonymous editors (no id) and AI sessions count once per socket: anon
  // tabs can't be told apart and each AI session is distinct.
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
  return unique
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
  // editor asks the user to reload. `invalid-update` is retried first (see
  // scheduleRestart): a fresh provider resyncs by state vector, which
  // replaces whatever the old one had queued.
  const syncRejection = ref<SyncCloseReason | null>(null)
  // The sync server is at a capacity limit (connections per address, open
  // documents): not an access decision. Retried with backoff until it
  // lets us in; the editor shows a short "busy, retrying" note meanwhile.
  const syncBusy = ref(false)

  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let busyAttempts = 0
  let resyncAttempts = 0

  function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer)
    if (stableTimer) clearTimeout(stableTimer)
    retryTimer = null
    stableTimer = null
  }

  /** Drop the current provider and open a new one after `delayMs`. */
  function scheduleRestart(delayMs: number) {
    provider.value?.destroy()
    provider.value = null
    status.value = 'connecting'
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delayMs)
  }

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
        syncBusy.value = false
        busyAttempts = 0
        // The resync budget refills only once the connection has stayed
        // up for a while: a rejected resend can arrive right after a sync.
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = setTimeout(() => {
          stableTimer = null
          resyncAttempts = 0
        }, RESYNC_STABLE_MS)
        docSizeBytes.value = Y.encodeStateAsUpdate(opts.ydoc).byteLength
        opts.onSynced?.()
      },
      onAuthenticationFailed: ({ reason }) => {
        if (isSyncBusyReason(reason)) {
          syncBusy.value = true
          // Not from inside the provider's own event dispatch.
          const delay = syncRetryDelayMs(busyAttempts++)
          queueMicrotask(() => scheduleRestart(delay))
          return
        }
        opts.onAuthFailed?.()
      },
      onClose: ({ event }) => {
        if (isReauthClose(event)) {
          opts.onReauthRequired?.()
          return
        }
        const rejection = syncRejectionFromClose(event)
        if (!rejection) return
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = null
        if (rejection === SYNC_CLOSE_REASONS.invalidUpdate && resyncAttempts < MAX_RESYNC_RETRIES) {
          // Possibly transient (an older sync server refusing edits queued
          // across its restart): resync from scratch instead of giving up.
          const delay = syncRetryDelayMs(resyncAttempts++)
          queueMicrotask(() => scheduleRestart(delay))
          return
        }
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
        userCount.value = countPresentUsers(states)
      }
    })
  }

  function disconnect() {
    clearTimers()
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
    syncBusy.value = false
    busyAttempts = 0
    resyncAttempts = 0
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
    syncBusy,
    connect,
    disconnect,
    reconnect,
    destroy
  }
}
