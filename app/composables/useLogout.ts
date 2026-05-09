// Logout cleanup pipeline.
//
// `useUserSession().clear()` only invalidates the server-side session
// cookie. It does NOT scrub:
//   - localStorage / sessionStorage — color-mode preference, theme
//     drafts, dismissed banners, and any incidental Y.js client state
//     that future code might write.
//   - IndexedDB — today markoto uses Hocuspocus server-side persistence
//     and never touches client IDB, but if @y-indexeddb is wired in later
//     a stale doc cache from the previous user could leak through. The
//     hook is here so we don't forget.
//   - Other tabs on the same origin — they keep acting logged-in until
//     their next API call hits 401, which can be hours.
//
// This composable wraps `clear()` with the full cleanup, broadcasts the
// logout to sibling tabs via BroadcastChannel, and finally redirects.
// Awareness teardown is the caller's responsibility (it owns the doc
// orchestrator) — the composable accepts an optional pre-clear hook so
// the editor can null out its awareness state before the cookie is gone.

export const LOGOUT_CHANNEL_NAME = 'markoto-auth'
// IDB names we proactively clear on logout. Prefix-matches via
// `startsWith` so we don't depend on `indexedDB.databases()` (Firefox
// only added it in 2024). Keep the list narrow — wiping unrelated DBs
// would be hostile to other origins sharing the browser profile.
export const LOGOUT_IDB_PREFIX = 'markoto-'

export interface LogoutOptions {
  /**
   * Called before any cleanup happens. Use to broadcast a final
   * "user is leaving" awareness frame to other doc collaborators
   * while the connection is still open. Failures are swallowed —
   * we never block logout on cleanup.
   */
  beforeClear?: () => void | Promise<void>
}

/**
 * Run the cleanup-and-clear pipeline. Resolves once the redirect to `/`
 * has been issued. Other tabs receive a `logged-out` broadcast and reload.
 */
export async function performLogout(opts: LogoutOptions = {}): Promise<void> {
  // 1. Awareness teardown FIRST — before we tear down the session, so
  //    other clients see the user-leaving frame on a still-open WS.
  try {
    await opts.beforeClear?.()
  } catch {
    // never block logout on awareness teardown
  }

  // 2. Cross-tab notification — every other tab on this origin reloads
  //    so they don't continue acting as the previous user. We post BEFORE
  //    clearing storage so other tabs can pull anything they need from
  //    the message payload (today: just the type discriminator).
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
      channel.postMessage({ type: 'logged-out' })
      channel.close()
    } catch {
      // Some embedded webviews don't support BroadcastChannel; fall through.
    }
  }

  // 3. Persistent client-state purge.
  try {
    localStorage.clear()
  } catch { /* user might have storage disabled */ }
  try {
    sessionStorage.clear()
  } catch { /* same */ }

  // 4. IndexedDB purge — only relevant if a future change wires up
  //    @y-indexeddb. `indexedDB.databases()` is Chromium-stable + Firefox
  //    126+; we soft-fail for Safari/older browsers.
  if (typeof indexedDB !== 'undefined' && 'databases' in indexedDB) {
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db.name && db.name.startsWith(LOGOUT_IDB_PREFIX)) {
          indexedDB.deleteDatabase(db.name)
        }
      }
    } catch {
      // Best-effort. A failed delete leaves stale data, but the next
      // login on the same browser overwrites or ignores it.
    }
  }

  // 5. Server-side session cookie cleared via nuxt-auth-utils.
  await useUserSession().clear()

  // 6. HARD reload to the public home page. We use `window.location`
  //    rather than `navigateTo()` for the same reason the cross-tab
  //    receiver in `auth-broadcast.client.ts` does: in-place teardown
  //    of the editor / AI / awareness / billing / account-status
  //    state machines isn't trustworthy. Pre-2025-05 this used a soft
  //    SPA navigation, which left the topbar showing a stale avatar
  //    + triggered 401 toasts from auto-fetching composables that
  //    raced ahead of the `loggedIn` ref reactively flipping. The
  //    full reload throws ALL Vue state away and re-bootstraps
  //    cleanly anonymous. Cost: one extra page load on logout — a
  //    rare action where correctness > perf.
  if (typeof window !== 'undefined') {
    globalThis.location.href = '/'
    return
  }
  // SSR fallback (logout from a non-browser context — shouldn't
  // happen in practice but keeps the contract well-defined).
  await navigateTo('/')
}

/**
 * Convenience composable that returns a callable `logout()` with the
 * pipeline pre-bound. Mirrors the shape of `useUserSession().clear()` so
 * call-sites can swap in with minimal churn.
 */
export function useLogout() {
  return {
    logout: (opts?: LogoutOptions) => performLogout(opts)
  }
}
