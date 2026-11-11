import { deleteExpiredWorkspaceInvites } from '../../repos/workspaceInvites'

// Workspace-invite sweeper. Deletes invitations past their 14-day
// expiry, so an address an admin typed is not kept longer than the
// invitation is usable (privacy policy: `workspace_invitations`).
// Idempotent — an already-deleted row simply doesn't match.

export interface WorkspaceInviteSweepResult {
  deletedExpired: number
}

export async function runWorkspaceInviteSweep(now: Date = new Date()): Promise<WorkspaceInviteSweepResult> {
  const deletedExpired = await deleteExpiredWorkspaceInvites(now)
  if (deletedExpired > 0) {
    console.log(`[workspace-invite-sweep] deleted ${deletedExpired} expired invitation(s)`)
  }
  return { deletedExpired }
}
