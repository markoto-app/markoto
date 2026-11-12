import type { DocTheme } from '~~/shared/types/theme'
import type { BrandFont } from '~~/shared/config/brandKit'

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
 *     a password-verified reconnect — it flips `requiresPassword` to false.
 */

export interface DocTokenState {
  token: string
  readOnly: boolean
}

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
  // The JWT + readOnly flag in use by the provider. Null = not fetched yet;
  // an empty token = the fetch failed (the user then sees a disconnected
  // state rather than a hang).
  const tokenData = ref<DocTokenState | null>(null)

  const isReadOnly = ref(false)
  // Set only when the sync layer rejected our auth at handshake time. Both
  // that and a server-declared read-only (`data.readOnly`) flip isReadOnly,
  // but only this one is a fault worth a banner.
  const syncAuthFailed = ref(false)
  const isOwner = ref(false)
  // Anonymous-created docs have `ownerId: null`: anyone with edit access can
  // change anything, including the theme. Logged-in docs always have an
  // owner, and only that owner gets theme write access.
  const hasOwner = ref(false)
  const requiresPassword = ref(false)
  // Private doc, non-owner: no token, and no client-side unlock path.
  const forbidden = ref(false)
  // Server-computed: would DELETE /api/docs/:id succeed for this caller
  // (owner / workspace admin; for an anonymous doc only its creating browser)?
  const canDelete = ref(false)
  // The token endpoint 404'd. Distinct from `forbidden` and from a transient
  // fetch failure, so the editor can show a not-found screen.
  const notFound = ref(false)
  const accessMode = ref<string>('open-edit')
  const workspaceId = ref<string | null>(null)
  const workspaceRole = ref<'admin' | 'editor' | 'viewer' | null>(null)
  // DB-stored theme (null = defaultTheme), returned by /token so the preview
  // paints before Y.js sync settles; ymeta.theme then takes over (bridged in `useDocument`).
  const initialTheme = ref<DocTheme | null>(null)
  // Plan features (server: `utils/entitlements.ts`). `false` = the plan has
  // no custom CSS: it stays in the theme but is left out of preview and print
  // (the server PDF renderer drops it too). Defaults to true so nothing
  // flickers before /token answers.
  const customCssAllowed = ref<boolean>(true)
  // Workspace brand kit: fonts every render declares, and the locked
  // workspace design (null = the document's own design).
  const brandFonts = ref<BrandFont[]>([])
  // Share-link controls: this viewer may not download or print; the public
  // link has expired (shown on the "no access" page).
  const noDownload = ref(false)
  const shareExpired = ref(false)
  const brandLockedTheme = ref<DocTheme | null>(null)
  /** Team / Business plan covering the doc's workspace (header badge). */
  const workspacePlan = ref<'team' | 'business' | null>(null)
  // Set when denied because the doc's workspace enforces single sign-on:
  // where to sign in through its IdP.
  const ssoLoginUrl = ref<string | null>(null)
  // Document context (description, audience, language): seeded from /token
  // like the theme, then bridged to ymeta.* in `useDocument`.
  const initialDescription = ref<string>('')
  // Title from the documents row; shown until the live `ymeta.title` exists.
  const initialTitle = ref<string>('')
  const initialAudience = ref<string>('casual')
  const initialLanguage = ref<string>('en')
  // Template the doc started from (exported in the Markdown frontmatter).
  const templateId = ref<string>('blank')
  // Template body with placeholders already substituted server-side. Null
  // for the `blank` template. Only seeded when ytext is empty.
  const initialBody = ref<string | null>(null)

  const { user: sessionUser } = useUserSession()

  // Set while a post-password-verify reconnect is in flight; the orchestrator
  // clears it via `clearPendingUnlock()` once the new provider syncs.
  const pendingPasswordUnlock = ref(false)

  async function fetchToken() {
    try {
      const data = await apiFetch('/api/docs/:docId/token', { path: { docId } })

      // The route answers `token: null` plus only the gate fields to a caller
      // who may not open the document; everything else exists only with a token.
      const granted = data.token === null ? null : data
      const denied = data.token === null ? data : null
      tokenData.value = { token: data.token ?? '', readOnly: data.readOnly }
      isReadOnly.value = data.readOnly
      requiresPassword.value = !!data.requiresPassword
      forbidden.value = !!data.forbidden
      canDelete.value = data.canDelete === true
      accessMode.value = data.accessMode
      workspaceId.value = data.workspaceId
      workspaceRole.value = data.workspaceRole
      initialTheme.value = data.theme ?? null
      customCssAllowed.value = data.planFeatures?.customCss !== false
      brandFonts.value = granted?.brandKit?.fonts ?? []
      brandLockedTheme.value = granted?.brandKit?.lockedTheme ?? null
      noDownload.value = granted?.noDownload === true
      shareExpired.value = denied?.shareExpired === true
      workspacePlan.value = data.workspacePlan ?? null
      ssoLoginUrl.value = denied?.ssoLoginUrl ?? null
      if (typeof granted?.title === 'string') initialTitle.value = granted.title
      if (typeof granted?.description === 'string') initialDescription.value = granted.description
      if (typeof granted?.audience === 'string') initialAudience.value = granted.audience
      if (typeof granted?.language === 'string') initialLanguage.value = granted.language
      if (typeof granted?.templateId === 'string') templateId.value = granted.templateId
      initialBody.value = typeof data.initialBody === 'string' ? data.initialBody : null

      const userId = sessionUser.value?.id
      isOwner.value = data.ownerId != null
        && typeof userId === 'number'
        && data.ownerId === userId
      hasOwner.value = data.ownerId != null
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
   * state (theme, doc-context, ownership) — a pure token refresh for the
   * reconnect and renewal paths. Updates `tokenData` + `isReadOnly` +
   * `noDownload` when the server issues a usable token.
   *
   * When it issues none, the access ended while the editor was open (link
   * expired, made private, password set, membership removed): flip to the
   * same gate a fresh page load would show — the orchestrator tears the
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
        if (data.forbidden || data.requiresPassword) {
          shareExpired.value = data.shareExpired === true
          ssoLoginUrl.value = data.ssoLoginUrl ?? null
          tokenData.value = { token: '', readOnly: true }
          isReadOnly.value = true
          if (data.forbidden) forbidden.value = true
          if (data.requiresPassword) requiresPassword.value = true
        }
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
   * near/at expiry, marked stale, or the server asked — the server only
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
      // A response without the document (still gated) carries none of the metadata.
      const meta = 'theme' in data ? data : null
      initialTheme.value = meta?.theme ?? null
      brandFonts.value = meta?.brandKit?.fonts ?? []
      brandLockedTheme.value = meta?.brandKit?.lockedTheme ?? null
      noDownload.value = meta?.noDownload === true
      if (typeof meta?.title === 'string') initialTitle.value = meta.title
      if (typeof meta?.description === 'string') initialDescription.value = meta.description
      if (typeof meta?.audience === 'string') initialAudience.value = meta.audience
      if (typeof meta?.language === 'string') initialLanguage.value = meta.language
      initialBody.value = typeof meta?.initialBody === 'string' ? meta.initialBody : null
    } catch {
      // Non-fatal — sync is the live source of these values.
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
    tokenData,
    isReadOnly,
    syncAuthFailed,
    isOwner,
    hasOwner,
    requiresPassword,
    forbidden,
    canDelete,
    notFound,
    accessMode,
    workspaceId,
    workspaceRole,
    pendingPasswordUnlock,
    initialTheme,
    customCssAllowed,
    brandFonts,
    brandLockedTheme,
    noDownload,
    shareExpired,
    workspacePlan,
    ssoLoginUrl,
    initialTitle,
    initialDescription,
    initialAudience,
    initialLanguage,
    initialBody,
    templateId,
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
