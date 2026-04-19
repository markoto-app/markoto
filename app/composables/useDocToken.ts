import type { DocTheme } from '~~/shared/types/theme'

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

export function useDocToken(docId: string) {
  // The JWT + readOnly flag currently in use by the provider. Null means we
  // haven't fetched yet; an empty-token object means the fetch failed (we
  // still connect so the user sees a disconnected state rather than hanging).
  const tokenData = ref<DocTokenState | null>(null)

  const isReadOnly = ref(false)
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
  const accessMode = ref<string>('open-edit')
  // DB-stored theme (or null = use defaultTheme). Initial value comes back
  // on the same /token round-trip so the preview can paint immediately,
  // before Y.js sync settles. Once synced, ymeta.theme takes over as the
  // live source — `useDocument` bridges the two.
  const initialTheme = ref<DocTheme | null>(null)

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
        theme?: DocTheme | null
      }>(`/api/docs/${docId}/token`)

      tokenData.value = { token: data.token ?? '', readOnly: data.readOnly }
      isReadOnly.value = data.readOnly
      requiresPassword.value = !!data.requiresPassword
      forbidden.value = !!data.forbidden
      accessMode.value = data.accessMode
      initialTheme.value = data.theme ?? null

      const userId = sessionUser.value?.id
      isOwner.value = data.ownerId != null
        && typeof userId === 'number'
        && data.ownerId === userId
      hasOwner.value = data.ownerId != null
    } catch {
      // Network / 404 / 403 — fall through to a no-token state. The provider
      // will stay disconnected; the UI surfaces that via `status`.
      tokenData.value = { token: '', readOnly: false }
    }
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

  function clearPendingUnlock() {
    if (pendingPasswordUnlock.value) {
      pendingPasswordUnlock.value = false
      requiresPassword.value = false
    }
  }

  /** Called by the sync layer on `onAuthenticationFailed`. */
  function markReadOnly() {
    isReadOnly.value = true
  }

  /** Called by ShareModal when the owner changes the access mode. */
  function setAccessMode(mode: string) {
    accessMode.value = mode
  }

  return {
    // State
    tokenData,
    isReadOnly,
    isOwner,
    hasOwner,
    requiresPassword,
    forbidden,
    accessMode,
    pendingPasswordUnlock,
    initialTheme,
    // Actions
    fetchToken,
    onPasswordVerified,
    clearPendingUnlock,
    markReadOnly,
    setAccessMode
  }
}
