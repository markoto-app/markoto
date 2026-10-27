import { declineInviteForUser, inAppInviteSelector } from '../../../../utils/workspaceInviteActions'

// POST /api/user/invites/:inviteId/decline — decline (delete) an
// invitation addressed to the signed-in user's account email.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const selector = await inAppInviteSelector(event, session.user.id)
  return declineInviteForUser(event, session.user.id, selector)
})
