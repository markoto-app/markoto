import { findUserById } from '../../../repos/users'
import { listInvitesForEmail } from '../../../repos/workspaceInvites'
import { normaliseInviteEmail } from '../../../utils/workspaces/workspaceInvites'
import { pooledPlansFor } from '../../../utils/billing/workspaceBilling'

// GET /api/user/invites — open workspace invitations addressed to the
// signed-in user's account email (only verified addresses are stored on
// accounts, so a match proves the mailbox). Drives the dashboard's
// "Invitations" section. Users without an email on file only receive
// invitations through the emailed link.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const user = await findUserById(session.user.id)
  const email = normaliseInviteEmail(user?.email)
  if (!email) return []

  const rows = await listInvitesForEmail(email, new Date())
  // A Team / Business plan of the workspace: the invite says what it
  // includes for the invitee (WP3).
  const plans = await pooledPlansFor(rows.map(r => r.workspaceId))
  return rows.map(r => ({
    workspacePlan: plans.get(r.workspaceId) ?? null,
    inviteId: r.inviteId,
    workspaceName: r.workspaceName,
    role: r.role,
    invitedByName: r.invitedByName,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString()
  }))
})
