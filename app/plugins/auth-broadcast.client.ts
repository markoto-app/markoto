// Cross-tab logout sync.
//
// `performLogout()` (composables/account/useLogout.ts) posts `logged-out` on a
// shared BroadcastChannel; every other tab reloads, so it doesn't keep acting
// as logged-in (cached user, enabled AI prompt bar) until its next API call
// hits 401, which can be hours.
//
// A reload rather than `useUserSession().clear()` in place: the editor, AI
// session and awareness state are too entangled for a non-reload tear-down
// to be trustworthy.

import { LOGOUT_CHANNEL_NAME } from '../composables/account/useLogout'

export default defineNuxtPlugin(() => {
  if (typeof BroadcastChannel === 'undefined') return

  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
  } catch {
    // Embedded webviews / privacy modes may throw; only cross-tab sync is lost.
    return
  }

  channel.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string } | null
    if (data?.type === 'logged-out') {
      // The tab that logged out already cleared its session (it receives its
      // own message too); only the others reload.
      const session = useUserSession()
      if (!session.loggedIn.value) return
      globalThis.location.reload()
    }
  })
})
