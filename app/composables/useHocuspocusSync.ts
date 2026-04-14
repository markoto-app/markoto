import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { Awareness } from 'y-protocols/awareness'

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
   *  first sync". Used to seed an empty doc with the welcome content only
   *  when the first load definitively failed. */
  onDisconnect?: (everSynced: boolean) => void
  /** Hocuspocus rejected the JWT — caller should flip `isReadOnly`. */
  onAuthFailed?: () => void
}

export function useHocuspocusSync(opts: HocuspocusSyncOptions) {
  const provider = ref<HocuspocusProvider | null>(null)
  const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const synced = ref(false)
  const userCount = ref(1)
  const docSizeBytes = ref(0)

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

    provider.value = new HocuspocusProvider({
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
        // `states` is an array of `{ clientId, ...user fields }` — one per
        // connected client including ourselves. Count is just `.length`.
        userCount.value = states.length
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
