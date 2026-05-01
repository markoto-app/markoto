// Fire-and-forget notifications from the Nuxt app → Hocuspocus sync-server.
// Never block the caller on sync-server being down / slow; the UX of the
// initiating mutation (delete doc, remove member, etc.) is more important
// than the kick happening immediately.
//
// notify-deleted lives in documentLifecycle.ts — that's called from the
// doc-delete path and has its own lifecycle notes. Membership-related
// kicks go through this file.

import { captureExceptionThrottled } from './throttledSentry'
import { injectTraceHeaders } from './traceHeaders'

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
