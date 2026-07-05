import * as Y from 'yjs'
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import type { Awareness } from 'y-protocols/awareness'

/**
 * Minimal shape the composable needs from a "provider". Real
 * HocuspocusProvider satisfies this; tests can inject a fake with the
 * same surface without having to mock the WebSocket stack.
 */
export interface ProviderLike {
  destroy(): void
}

/**
 * Owns the Hocuspocus provider lifecycle — WebSocket connect, reconnect,
 * disconnect, and the `status` / `synced` / `userCount` / `docSizeBytes`
 * reactivity derived from provider events.
 *
 * Doesn't know or care about access mode, passwords, ownership, or the Y.Doc
 * contents themselves. That split is deliberate: this composable is the
 * "dumb transport layer" and can be reasoned about in isolation.
 *
 * The orchestrator (`useDocument`) threads together the token, awareness, and
 * Y.Doc, then calls `connect()` at the right moment (never for forbidden or
 * password-gated docs pre-verification).
 */

export interface HocuspocusSyncOptions {
  docId: string
  ydoc: Y.Doc
  awareness: Awareness
  syncUrl: string
  /** Called to read the current JWT at connect time. Changes over the doc's
   *  lifetime (anonymous → password-verified) so we read it lazily. */
  getToken: () => string
  /** Fires on every successful sync (initial load + later reconnects). */
  onSynced?: () => void
  /** Fires on disconnect; receives whether we ever synced in this provider's
   *  lifetime so the caller can distinguish "server offline" from "lost after
   *  first sync" (useful for status/telemetry). NOTE: the caller must NOT
   *  seed doc content from here — a disconnect before any sync means the
   *  server's content is unknown, and a local seed would merge with real
   *  content on auto-reconnect (F9). Welcome seeding lives on `onSynced`
   *  only. */
  onDisconnect?: (everSynced: boolean) => void
  /** Hocuspocus rejected the JWT — caller should flip `isReadOnly`. */
  onAuthFailed?: () => void
  /**
   * Factory for the underlying provider. Production passes no value and
   * gets a real HocuspocusProvider; tests inject a fake that captures the
   * config (including the lifecycle callbacks) so they can fire
   * `onConnect` / `onSynced` / `onDisconnect` / `onAuthenticationFailed`
   * / `onAwarenessChange` on demand without touching WebSockets.
   */
  providerFactory?: (config: HocuspocusProviderConfiguration) => ProviderLike
}

export function useHocuspocusSync(opts: HocuspocusSyncOptions) {
  // shallowRef: the provider is an opaque handle (we only care about
  // identity + its `.destroy()` method). Using `ref` would wrap the
  // instance in a Proxy and break reference comparisons anywhere
  // upstream that holds onto `.value`.
  const provider = shallowRef<ProviderLike | null>(null)
  const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const synced = ref(false)
  const userCount = ref(1)
  const docSizeBytes = ref(0)

  const makeProvider = opts.providerFactory
    ?? ((config: HocuspocusProviderConfiguration) => new HocuspocusProvider(config))

  function connect() {
    // No sync URL configured (e.g. pure-offline dev): simulate a "synced,
    // disconnected" state so the editor still renders. The caller decides
    // whether to seed welcome content (see `onSynced` callback).
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
      token: opts.getToken(),
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
      onAwarenessChange: ({ states }) => {
        // Dedup by `user.id` so multiple tabs of the SAME human don't
        // inflate the count. Anonymous editors (no `user.id`) and AI
        // sessions stay as one entry per socket — we can't tell anon
        // tabs apart, and each AI session is genuinely distinct. This
        // keeps the chip's number aligned with what PresenceBar
        // actually shows: open the same doc twice in two tabs as the
        // same logged-in user and you see one avatar, not two — the
        // count must match.
        //
        // Real `user.id` values are NUMERIC (DB-issued). The 'anonymous'
        // sentinel is the only legitimate string. A numeric string
        // (e.g. "42") would dedup correctly via Number coercion below,
        // but its appearance signals a regression at a JWT mint site or
        // session helper — log it so we can chase it down rather than
        // letting it silently work-by-accident.
        const seenUserIds = new Set<number>()
        let unique = 0
        for (const s of states) {
          const u = (s as { user?: { id?: number | string, isAI?: boolean } }).user
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
            // Non-numeric string id should never happen — sound the alarm
            // and treat the connection as anonymous (don't count toward
            // dedup) rather than crashing the user-count chip.
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
   * Tear down the current provider and connect fresh. Used by the orchestrator
   * after a password-verified token swap — the existing provider carries a
   * rejected-or-absent token and must be replaced wholesale.
   */
  function reconnect() {
    disconnect()
    // Reset sync tracking so the next `onSynced` fires the welcome-seed / clear-
    // pending-unlock branches fresh. docSizeBytes gets recomputed on sync.
    synced.value = false
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
    connect,
    disconnect,
    reconnect,
    destroy
  }
}
