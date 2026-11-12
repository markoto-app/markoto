import { applyAccessEnded, applyTokenAnswer, applyUnlockedMeta, createDocAccessState } from './docAccessState'

/**
 * Owns the auth/access-mode side of a document: fetching the Hocuspocus JWT,
 * tracking what access tier we ended up in (readOnly / requiresPassword /
 * forbidden), and the post-password-verify reconnect dance.
 *
 * This is split out of `useDocument` so the sync-provider code next door has
 * one less thing to worry about. The orchestrator consumes the reactive state
 * and triggers (re)connection when the token changes.
 *
 * Password flow:
 *   - The server returns `token: null` for password-protected docs (non-owner)
 *     so no JWT is ever issued pre-verification. The client never has a usable
 *     token for the doc until the user enters the correct password.
 *   - On `onPasswordVerified(newToken)`: we stash the new token and raise a
 *     `pendingUnlock` flag, but keep `requiresPassword` true until the
 *     orchestrator confirms a post-reconnect sync. That prevents the "editor
 *     mounts empty, user types, then synced content overwrites" race.
 *   - `clearPendingUnlock()` is called by the orchestrator on first sync after
 *     a password-verified reconnect: it flips `requiresPassword` to false.
 */

// Refetch the JWT when it's within this window of expiring. The doc token
// has a 2h TTL and HocuspocusProvider re-invokes its token callback on every
// (re)connect, so refreshing here keeps a >2h-old session from reconnecting
// with a dead JWT and being bounced to read-only. 60s absorbs clock skew +
// the handshake round-trip.
const TOKEN_REFRESH_BUFFER_MS = 60_000

/**
 * Read a JWT's `exp` as epoch ms WITHOUT verifying the signature: it only
 * decides when to refetch, and the sync server re-verifies on every
 * handshake. Null (unparseable) makes the caller refresh now.
 */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    // base64url: restore the standard alphabet + padding before atob. The
    // payload is ASCII JSON, so atob's binary string parses cleanly.
    const b64 = (parts[1] ?? '').replaceAll('-', '+').replaceAll('_', '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function isTokenExpiringSoon(token: string): boolean {
  const expMs = jwtExpiryMs(token)
  if (expMs === null) return true
  return expMs - Date.now() < TOKEN_REFRESH_BUFFER_MS
}

export function useDocToken(docId: string) {
  const state = createDocAccessState()
  const { tokenData, isReadOnly, syncAuthFailed, requiresPassword, notFound, accessMode, noDownload, pendingPasswordUnlock } = state

  const { user: sessionUser } = useUserSession()

  async function fetchToken() {
    try {
      const data = await apiFetch('/api/docs/:docId/token', { path: { docId } })
      applyTokenAnswer(state, data, sessionUser.value?.id)
    } catch (e: unknown) {
      // 404 = the doc doesn't exist. Any other error (network, 5xx) stays a
      // transient no-token state surfaced via `status`.
      const status = e as { statusCode?: number, status?: number, response?: { status?: number } }
      if (status?.statusCode === 404 || status?.status === 404 || status?.response?.status === 404) {
        notFound.value = true
      }
      tokenData.value = { token: '', readOnly: false }
    }
  }

  // Set when the sync server closed the connection for re-authentication:
  // the held token may still look valid but no longer opens the doc.
  let tokenStale = false

  /**
   * Fetch a fresh JWT from `/token` WITHOUT disturbing the rest of the doc
   * state (theme, doc-context, ownership), a pure token refresh for the
   * reconnect and renewal paths. Updates `tokenData` + `isReadOnly` +
   * `noDownload` when the server issues a usable token.
   *
   * When it issues none, the access ended while the editor was open (link
   * expired, made private, password set, membership removed): flip to the
   * same gate a fresh page load would show, the orchestrator tears the
   * connection down on that. A password-gated visitor lands back on the
   * password prompt: its JWT came from `/password` and can't be re-minted
   * without the password. A failed fetch (offline, 5xx) changes nothing
   * and returns null, so the caller keeps what it has.
   */
  async function refetchTokenOnly(): Promise<string | null> {
    try {
      // `refresh`: not a new open of the doc (view counts skip it).
      const data = await apiFetch('/api/docs/:docId/token', { path: { docId }, query: { refresh: '1' } })
      if (data.token === null) {
        applyAccessEnded(state, data)
        return null
      }
      if (!data.token) return null
      tokenData.value = { token: data.token, readOnly: data.readOnly }
      isReadOnly.value = data.readOnly
      if (typeof data.noDownload === 'boolean') noDownload.value = data.noDownload
      tokenStale = false
      return data.token
    } catch {
      return null
    }
  }

  /**
   * Token accessor handed to the sync provider. HocuspocusProvider calls
   * this on every (re)connect, and when the sync server asks for a fresh
   * token shortly before the current one expires (`renewal`). Returns the
   * current JWT while it's still comfortably valid; refetches when it's
   * near/at expiry, marked stale, or the server asked, the server only
   * asks near expiry, so trusting the request rather than our own clock
   * keeps renewal working when the browser's clock is off. Falls back to
   * the current token when a refetch can't issue a new one (offline): the
   * server then closes the connection at expiry and the reconnect tries
   * again. Returns '' once access has ended.
   */
  async function getFreshToken(opts: { renewal?: boolean } = {}): Promise<string> {
    const current = tokenData.value?.token || ''
    if (!current) return '' // no token yet / forbidden / password-gated pre-unlock
    if (!opts.renewal && !tokenStale && !isTokenExpiringSoon(current)) return current
    const refreshed = await refetchTokenOnly()
    return refreshed ?? (tokenData.value?.token || '')
  }

  /** The sync server asked us to re-authenticate: refetch on the next connect. */
  function invalidateToken() {
    tokenStale = true
  }

  /**
   * Called by PasswordModal after `/password` verified and returned a JWT.
   * Swaps the token in place; the orchestrator watches for this and triggers
   * a provider reconnect. `requiresPassword` stays true until the first sync
   * completes (see `clearPendingUnlock`).
   */
  function onPasswordVerified(newToken: string) {
    pendingPasswordUnlock.value = true
    isReadOnly.value = false
    tokenData.value = { token: newToken, readOnly: false }
    tokenStale = false
  }

  /**
   * After a password unlock, fetch the doc's metadata with the new JWT
   * (`/meta` accepts it as proof of the unlock). The `/token` response a
   * gated visitor got earlier carries no metadata (no theme, description,
   * template body), so this re-seeds the `initial*` refs before the
   * provider syncs. Best-effort: on failure the refs keep their defaults
   * and Y.js sync delivers the live values anyway.
   */
  async function hydrateAfterUnlock(newToken: string): Promise<void> {
    try {
      const data = await apiFetch('/api/docs/:docId/meta', { path: { docId }, headers: { Authorization: `Bearer ${newToken}` } })
      applyUnlockedMeta(state, data)
    } catch {
      // Non-fatal: sync is the live source of these values.
    }
  }

  function clearPendingUnlock() {
    if (pendingPasswordUnlock.value) {
      pendingPasswordUnlock.value = false
      requiresPassword.value = false
    }
  }

  /** Called by the sync layer on `onAuthenticationFailed`. */
  function markReadOnly() {
    isReadOnly.value = true
    // Handshake rejected (rate limit, clock skew, changed secret…). EditorLayout
    // shows a banner so users can tell this from "you don't have edit access".
    syncAuthFailed.value = true
  }

  /** Called by ShareModal when the owner changes the access mode. */
  function setAccessMode(mode: string) {
    accessMode.value = mode
  }

  return {
    ...state,
    fetchToken,
    hydrateAfterUnlock,
    getFreshToken,
    invalidateToken,
    onPasswordVerified,
    clearPendingUnlock,
    markReadOnly,
    setAccessMode
  }
}
