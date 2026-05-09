// Cross-tab logout sync.
//
// When one tab calls `performLogout()` (see `composables/useLogout.ts`)
// it posts a `logged-out` message on a shared BroadcastChannel. This
// plugin listens on every tab. On receipt, the tab reloads — middleware
// then sees the cleared session cookie and routes to `/`.
//
// Without this, a second tab keeps acting as if logged-in (cached user
// in `useUserSession()` reactivity, AI prompt bar enabled, etc.) until
// its next API call hits 401 and triggers a forced refresh — which can
// be hours of stale UI.
//
// We deliberately reload rather than calling `useUserSession().clear()`
// in-place: the in-page state-machine has too many tendrils (open
// editor, AI session, awareness) for a non-reload tear-down to be
// trustworthy. A reload is universally safe and matches what the
// middleware will do on the next API call anyway.

import { LOGOUT_CHANNEL_NAME } from '../composables/useLogout'

export default defineNuxtPlugin(() => {
  if (typeof BroadcastChannel === 'undefined') return

  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
  } catch {
    // Embedded webviews / privacy-mode contexts may throw. Soft-fail —
    // the user just loses cross-tab sync, not core functionality.
    return
  }

  channel.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string } | null
    if (data?.type === 'logged-out') {
      // The local `performLogout()` already cleared this tab; only
      // _other_ tabs need to reload. Detect "this is me" by checking if
      // the session has already gone — if it has, skip.
      const session = useUserSession()
      if (!session.loggedIn.value) return
      globalThis.location.reload()
    }
  })
})
