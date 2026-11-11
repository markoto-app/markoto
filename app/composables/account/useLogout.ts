// Logout cleanup pipeline.
//
// `useUserSession().clear()` only invalidates the server-side session
// cookie. It does not scrub:
//   - localStorage / sessionStorage (color mode, drafts, dismissed banners).
//   - IndexedDB: nothing uses it today, but a future client-side doc cache
//     (e.g. @y-indexeddb) would leak to the next user.
//   - Other tabs on the same origin, which keep acting logged-in until
//     their next API call hits 401.
//
// So this wraps `clear()` with the cleanup, notifies sibling tabs via
// BroadcastChannel, and redirects. The caller owns awareness teardown and
// passes it as the optional `beforeClear` hook.

export const LOGOUT_CHANNEL_NAME = 'markoto-auth'
// IDB databases cleared on logout, matched by name prefix. Keep it narrow:
// wiping unrelated DBs would be hostile to other apps in the browser profile.
export const LOGOUT_IDB_PREFIX = 'markoto-'

export interface LogoutOptions {
  /**
   * Runs before any cleanup, while the WS is still open, so the editor can
   * broadcast a final "user is leaving" awareness frame. Failures are
   * swallowed: cleanup never blocks logout.
   */
  beforeClear?: () => void | Promise<void>
}

/** Resolves once the redirect to `/` has been issued; other tabs reload on the broadcast. */
export async function performLogout(opts: LogoutOptions = {}): Promise<void> {
  await runBeforeClear(opts.beforeClear)
  clearWebStorage()
  await purgeMarkotoIdb()
  await useUserSession().clear()
  // Must come AFTER the session is cleared: this tab's own receiver
  // (app/plugins/auth-broadcast.client.ts) hears it too, and posted earlier it
  // would reload the page and abort the in-flight DELETE, leaving the cookie.
  broadcastLoggedOut()
  await redirectHome()
}

async function runBeforeClear(hook: LogoutOptions['beforeClear']): Promise<void> {
  if (!hook) return
  try {
    await hook()
  } catch { /* never block logout on awareness teardown */ }
}

/** Makes every other tab on this origin reload instead of continuing as the previous user. */
function broadcastLoggedOut(): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
    channel.postMessage({ type: 'logged-out' })
    channel.close()
  } catch {
    // Some embedded webviews lack BroadcastChannel.
  }
}

function clearWebStorage(): void {
  try {
    localStorage.clear()
  } catch { /* storage may be disabled */ }
  try {
    sessionStorage.clear()
  } catch { /* same */ }
}

/**
 * `indexedDB.databases()` is missing in older Safari/Firefox; those skip the
 * purge, and a failed delete only leaves data the next login ignores.
 */
async function purgeMarkotoIdb(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !('databases' in indexedDB)) return
  try {
    const dbs = await indexedDB.databases()
    for (const db of dbs) {
      if (db.name?.startsWith(LOGOUT_IDB_PREFIX)) {
        indexedDB.deleteDatabase(db.name)
      }
    }
  } catch { /* best-effort */ }
}

/**
 * Hard reload, not `navigateTo()`: a soft navigation leaves stale state
 * (topbar avatar) and triggers 401 toasts from auto-fetching composables
 * that race the `loggedIn` flip. A reload discards all Vue state; one extra
 * page load on a rare action is worth the correctness.
 */
async function redirectHome(): Promise<void> {
  if (globalThis.window !== undefined) {
    globalThis.location.href = '/'
    return
  }
  await navigateTo('/')
}

export function useLogout() {
  return {
    logout: (opts?: LogoutOptions) => performLogout(opts)
  }
}
