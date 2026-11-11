// Fire-and-forget notifications from the Nuxt app → Hocuspocus sync-server.
// Never block the caller on sync-server being down / slow; the UX of the
// initiating mutation (delete doc, remove member, etc.) is more important
// than the kick happening immediately.
//
// notify-deleted lives in documentLifecycle.ts — that's called from the
// doc-delete path and has its own lifecycle notes. Membership-related
// kicks go through this file.

import { captureExceptionThrottled } from '../platform/throttledSentry'
import { injectTraceHeaders } from '../platform/traceHeaders'

/**
 * Force-close all live Y.js connections for `userId` on the given docs.
 *
 * Call this after any workspace mutation that reduces a user's effective
 * access: role demotion, removal, workspace delete. The client's provider
 * auto-reconnects, re-hits `/api/docs/:id/token`, and gets a token that
 * matches the new authz state. Kick = refresh.
 *
 * Over-kicking is cheap (a UI flicker) and under-kicking is a silent
 * security bug (stale JWT retains old access until 2h expiry), so err
 * on the side of kicking whenever membership changes.
 */
export function notifySyncKickUser(userId: number, docIds: string[]): void {
  if (docIds.length === 0) return
  const config = useRuntimeConfig()
  if (!config.syncInternalUrl || !config.internalApiSecret) return

  // No await — fire-and-forget. 3 s timeout matches notify-deleted.
  fetch(`${config.syncInternalUrl}/internal/kick-user`, {
    method: 'POST',
    headers: injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalApiSecret
    }),
    body: JSON.stringify({ userId, docIds }),
    signal: AbortSignal.timeout(3000)
  }).catch((e) => {
    console.warn(`[syncNotify] kick-user for user ${userId} failed:`, e instanceof Error ? e.message : e)
    captureExceptionThrottled('syncNotify.kick-user', e, {
      tags: { component: 'syncNotify', event: 'kick_user_failed' }
    })
  })
}

/**
 * Make everyone connected to `docId` re-authenticate. Call after any
 * change that makes a document's access stricter (access mode, password,
 * link expiry / view-only, moderation restriction, workspace move): the
 * sync-server refuses every doc token issued before now and closes the
 * document's connections, so each editor fetches a fresh token — and an
 * editor that no longer gets one lands on the no-access screen.
 *
 * Call it AFTER the access change is written: the cutoff is this
 * second, and a token minted before the write would still carry the old
 * access. Fire-and-forget like the kick above; with several sync-server
 * instances only the one behind `syncInternalUrl` closes its connections
 * (the token cutoff applies on all of them).
 */
export function notifySyncReauthDocument(docId: string): void {
  const config = useRuntimeConfig()
  if (!config.syncInternalUrl || !config.internalApiSecret) return

  fetch(`${config.syncInternalUrl}/internal/reauth-document`, {
    method: 'POST',
    headers: injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalApiSecret
    }),
    body: JSON.stringify({ docId, notBefore: Math.floor(Date.now() / 1000) }),
    signal: AbortSignal.timeout(3000)
  }).then((res) => {
    if (!res.ok) throw new Error(`reauth-document answered ${res.status}`)
  }).catch((e) => {
    console.warn(`[syncNotify] reauth-document for ${docId} failed:`, e instanceof Error ? e.message : e)
    captureExceptionThrottled('syncNotify.reauth-document', e, {
      tags: { component: 'syncNotify', event: 'reauth_document_failed' }
    })
  })
}

/**
 * Ask the sync-server to persist a document's pending edits NOW (its
 * store is debounced 2–10 s) and wait until it has. Call before reading
 * a live document's `yjs_documents` rows — `duplicateDocument` clones
 * them, and without the flush a duplicate made right after an edit
 * missed that edit.
 *
 * Unlike the kick above this one is awaited, but it never fails the
 * caller: on timeout / sync-server down it reports false and the caller
 * proceeds with what is persisted (the pre-fix behaviour). With several
 * sync-server instances only the one behind `syncInternalUrl` is
 * flushed; sticky sessions keep a document's writers on one instance.
 */
export async function flushSyncDocument(docId: string): Promise<boolean> {
  const config = useRuntimeConfig()
  if (!config.syncInternalUrl || !config.internalApiSecret) return false
  try {
    const res = await fetch(`${config.syncInternalUrl}/internal/flush-document`, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.internalApiSecret
      }),
      body: JSON.stringify({ docId }),
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) throw new Error(`flush-document answered ${res.status}`)
    return true
  } catch (e) {
    console.warn(`[syncNotify] flush-document for ${docId} failed:`, e instanceof Error ? e.message : e)
    captureExceptionThrottled('syncNotify.flush-document', e, {
      tags: { component: 'syncNotify', event: 'flush_document_failed' }
    })
    return false
  }
}
