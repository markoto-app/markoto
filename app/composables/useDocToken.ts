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
 * Notes on the password flow:
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

// Refetch the JWT when it's within this window of expiring (or already
// expired). The doc token is minted with a 2h TTL; HocuspocusProvider
// re-invokes its token callback on every (re)connect, so refreshing here
// keeps a >2h-old session from reconnecting with a dead JWT and getting
// bounced to read-only (F5: `onAuthenticationFailed` → `markReadOnly`).
// 60s of slack absorbs clock skew + the handshake round-trip.
const TOKEN_REFRESH_BUFFER_MS = 60_000

/**
 * Read a JWT's `exp` (epoch seconds) as epoch ms WITHOUT verifying the
 * signature — we only need to know when to refetch, and the sync server
 * re-verifies the token on every handshake regardless. Returns null when
 * the token is absent or unparseable, which the caller treats as "refresh
 * now" (fail safe toward refetching rather than presenting a dead token).
 */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    // JWT payload is base64url (URL-safe alphabet, no padding). Restore
    // the standard alphabet + padding before atob. The payload is ASCII
    // JSON (docId/userId/readOnly/scope/iat/exp), so atob's binary string
    // parses cleanly.
    const b64 = parts[1]!.replaceAll('-', '+').replaceAll('_', '/')
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
  // The JWT + readOnly flag currently in use by the provider. Null means we
  // haven't fetched yet; an empty-token object means the fetch failed (we
  // still connect so the user sees a disconnected state rather than hanging).
  const tokenData = ref<DocTokenState | null>(null)

  const isReadOnly = ref(false)
  // Distinguishes "server told us we're read-only" (workspace viewer,
  // password-gated, etc. — `data.readOnly === true`) from "sync layer
  // rejected our auth at handshake time". Both flip isReadOnly, but
  // only the latter is a fault state worth surfacing in the UI —
  // legit read-only docs don't need a banner.
  const syncAuthFailed = ref(false)
  const isOwner = ref(false)
  // Whether the doc has *any* owner. Anonymous-created docs land with
  // `ownerId: null`; they default to open-edit and follow "anyone with
  // edit access can change anything", including the theme. Logged-in
  // docs always have an owner; only that owner gets theme write access.
  const hasOwner = ref(false)
  const requiresPassword = ref(false)
  // Private doc, non-owner: same "no token" treatment as password-protected
  // but with no client-side unlock path. EditorLayout renders a lock screen.
  const forbidden = ref(false)
  // Server-computed: would DELETE /api/docs/:id succeed for this caller?
  // (Owner / workspace admin; for an anonymous doc only the browser that
  // created it.) Drives whether the File menu offers "Delete".
  const canDelete = ref(false)
  // The doc doesn't exist (token endpoint 404'd). Distinct from `forbidden`
  // (exists but you can't see it) and from a transient fetch failure — the
  // editor renders a dedicated not-found screen instead of a misleading
  // "disconnected / view only" dead end.
  const notFound = ref(false)
  const accessMode = ref<string>('open-edit')
  // Current workspace assignment + caller's role inside it, if any. Used
  // by the File menu to decide which of Duplicate / Move / Delete to
  // render, and by MoveWorkspaceModal to preselect "current workspace".
  const workspaceId = ref<string | null>(null)
  const workspaceRole = ref<'admin' | 'editor' | 'viewer' | null>(null)
  // DB-stored theme (or null = use defaultTheme). Initial value comes back
  // on the same /token round-trip so the preview can paint immediately,
  // before Y.js sync settles. Once synced, ymeta.theme takes over as the
  // live source — `useDocument` bridges the two.
  const initialTheme = ref<DocTheme | null>(null)
  // Plan features of this document (server: `utils/entitlements.ts`).
  // `customCss: false` = the doc's plan doesn't include custom CSS: the
  // stored CSS stays in the theme but is left out of the preview and the
  // browser print (the server-side PDF renderer drops it too). Defaults
  // to true so nothing flickers before /token answers.
  const customCssAllowed = ref<boolean>(true)
  // Workspace brand kit (WP10): fonts every render declares, and the
  // locked workspace design (null = the document's own design).
  const brandFonts = ref<BrandFont[]>([])
  // Share-link controls (WP9): this viewer may not download or print;
  // the public link has expired (shown on the "no access" page).
  const noDownload = ref(false)
  const shareExpired = ref(false)
  const brandLockedTheme = ref<DocTheme | null>(null)
  /** Team / Business plan covering the doc's workspace (header badge, WP6). */
  const workspacePlan = ref<'team' | 'business' | null>(null)
  // Denied because the doc's workspace enforces single sign-on (WP14):
  // where to sign in through its IdP.
  const ssoLoginUrl = ref<string | null>(null)
  // Document context — description (what the doc is about), audience
  // (writing register), language (output language). Same dual-source
  // pattern as theme: the /token round-trip seeds an initial value so
  // the Document tab can hydrate before sync, and ymeta.* mirrors are
  // bridged in `useDocument` for live cross-client updates.
  const initialDescription = ref<string>('')
  // Title stored on the documents row (from the new-document dialog).
  // `useDocument` shows it until the live `ymeta.title` exists.
  const initialTitle = ref<string>('')
  const initialAudience = ref<string>('casual')
  const initialLanguage = ref<string>('en')
  // Which template the doc started from (exported in the Markdown
  // frontmatter; a Markdown import can restore it).
  const templateId = ref<string>('blank')
  // Pre-rendered template body (with title/description placeholders
  // already substituted server-side, locale-matched). Null when the
  // doc was created with the `blank` template — the document then stays
  // empty. Only seeded when ytext is empty.
  const initialBody = ref<string | null>(null)

  const { user: sessionUser } = useUserSession()

  // Set when a post-password-verify reconnect is in flight. The orchestrator
  // flips it to false via `clearPendingUnlock()` once the new provider syncs —
  // see `useDocument.ts` for the wiring.
  const pendingPasswordUnlock = ref(false)

  async function fetchToken() {
    try {
      const data = await $fetch<{
        token: string | null
        readOnly: boolean
        requiresPassword?: boolean
        forbidden?: boolean
        accessMode: string
        ownerId: number | null
        workspaceId: string | null
        workspaceRole: 'admin' | 'editor' | 'viewer' | null
        theme?: DocTheme | null
        title?: string
        description?: string
        audience?: string
        language?: string
        initialBody?: string | null
        templateId?: string
        canDelete?: boolean
        planFeatures?: { customCss?: boolean } | null
        brandKit?: { fonts?: BrandFont[], lockedTheme?: DocTheme | null } | null
        noDownload?: boolean
        shareExpired?: boolean
        workspacePlan?: 'team' | 'business' | null
        ssoLoginUrl?: string | null
      }>(`/api/docs/${docId}/token`)

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
      brandFonts.value = data.brandKit?.fonts ?? []
      brandLockedTheme.value = data.brandKit?.lockedTheme ?? null
      noDownload.value = data.noDownload === true
      shareExpired.value = data.shareExpired === true
      workspacePlan.value = data.workspacePlan ?? null
      ssoLoginUrl.value = data.ssoLoginUrl ?? null
      if (typeof data.title === 'string') initialTitle.value = data.title
      if (typeof data.description === 'string') initialDescription.value = data.description
      if (typeof data.audience === 'string') initialAudience.value = data.audience
      if (typeof data.language === 'string') initialLanguage.value = data.language
      if (typeof data.templateId === 'string') templateId.value = data.templateId
      initialBody.value = typeof data.initialBody === 'string' ? data.initialBody : null

      const userId = sessionUser.value?.id
      isOwner.value = data.ownerId != null
        && typeof userId === 'number'
        && data.ownerId === userId
      hasOwner.value = data.ownerId != null
    } catch (e: unknown) {
      // A 404 means the doc genuinely doesn't exist — flag it so the editor
      // shows a not-found screen rather than silently falling through to a
      // "disconnected / view only" dead end (the provider would never
      // connect with an empty token). Any other error (network, 5xx) stays a
      // transient no-token state surfaced via `status`.
      const status = e as { statusCode?: number, status?: number, response?: { status?: number } }
      if (status?.statusCode === 404 || status?.status === 404 || status?.response?.status === 404) {
        notFound.value = true
      }
      tokenData.value = { token: '', readOnly: false }
    }
  }

  /**
   * Fetch a fresh JWT from `/token` WITHOUT disturbing the rest of the doc
   * state (theme, doc-context, ownership) — a pure token refresh for the
   * reconnect path. Updates `tokenData` + `isReadOnly` only when the server
   * issues a usable token. A password-gated doc (non-owner) returns
   * `token: null` here — its usable JWT came from `/password`, which we
   * can't re-mint without the password — so we DON'T clobber the existing
   * token to empty; we return null and let the caller keep what it has.
   */
  async function refetchTokenOnly(): Promise<string | null> {
    try {
      // `refresh`: not a new open of the doc (WP9 view counts skip it).
      const data = await $fetch<{ token: string | null, readOnly: boolean }>(
        `/api/docs/${docId}/token`, { query: { refresh: '1' } }
      )
      if (!data.token) return null
      tokenData.value = { token: data.token, readOnly: data.readOnly }
      isReadOnly.value = data.readOnly
      return data.token
    } catch {
      return null
    }
  }

  /**
   * Token accessor handed to the sync provider. HocuspocusProvider calls
   * this on every (re)connect. Returns the current JWT while it's still
   * comfortably valid; refetches a fresh one when it's near/at expiry so a
   * long-lived (>2h) session's reconnect doesn't present a dead token and
   * get bounced to read-only (F5). Falls back to the current token when a
   * refetch can't issue a new one (offline, or a password-gated doc whose
   * JWT can't be silently reminted) — that reconnect may still fail auth,
   * exactly as it did before, so this is never worse than the old path.
   */
  async function getFreshToken(): Promise<string> {
    const current = tokenData.value?.token || ''
    if (!current) return '' // no token yet / forbidden / password-gated pre-unlock
    if (!isTokenExpiringSoon(current)) return current
    const refreshed = await refetchTokenOnly()
    return refreshed ?? current
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
      const data = await $fetch<{
        theme?: DocTheme | null
        title?: string
        description?: string
        audience?: string
        language?: string
        initialBody?: string | null
        brandKit?: { fonts?: BrandFont[], lockedTheme?: DocTheme | null } | null
        noDownload?: boolean
      }>(`/api/docs/${docId}/meta`, { headers: { Authorization: `Bearer ${newToken}` } })
      initialTheme.value = data.theme ?? null
      brandFonts.value = data.brandKit?.fonts ?? []
      brandLockedTheme.value = data.brandKit?.lockedTheme ?? null
      noDownload.value = data.noDownload === true
      if (typeof data.title === 'string') initialTitle.value = data.title
      if (typeof data.description === 'string') initialDescription.value = data.description
      if (typeof data.audience === 'string') initialAudience.value = data.audience
      if (typeof data.language === 'string') initialLanguage.value = data.language
      initialBody.value = typeof data.initialBody === 'string' ? data.initialBody : null
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
    // Sync handshake rejected (rate limit, JWT clock skew, sync container
    // restart with a different secret, etc.). EditorLayout watches this
    // and surfaces a banner — without it the editor silently flips to
    // preview and users can't tell the difference between "you don't
    // have edit access" and "the sync server bounced you".
    syncAuthFailed.value = true
  }

  /** Called by ShareModal when the owner changes the access mode. */
  function setAccessMode(mode: string) {
    accessMode.value = mode
  }

  return {
    // State
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
    // Actions
    fetchToken,
    hydrateAfterUnlock,
    getFreshToken,
    onPasswordVerified,
    clearPendingUnlock,
    markReadOnly,
    setAccessMode
  }
}
