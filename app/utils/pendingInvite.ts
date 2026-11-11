// Workspace-invitation token parked across the sign-in round trip.
//
// The emailed link lands on `/invites/accept?token=…`. A signed-out
// visitor has to sign in first, and every OAuth callback redirects to
// `/` — so the accept page stores the token here and the dashboard
// sends the (now signed-in) user back to the accept page. sessionStorage
// only (tab-scoped, cleared on logout); every access is guarded because
// storage can be disabled.

const PENDING_INVITE_KEY = 'markoto-pending-invite'

export function storePendingInviteToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, token)
  } catch { /* storage disabled — the user can reopen the email link */ }
}

export function readPendingInviteToken(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_INVITE_KEY)
    return value && /^[\w-]{20,128}$/.test(value) ? value : null
  } catch {
    return null
  }
}

export function clearPendingInviteToken(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY)
  } catch { /* nothing to clear */ }
}
