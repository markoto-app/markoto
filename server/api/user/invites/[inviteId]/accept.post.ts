import { acceptInviteForUser, inAppInviteSelector } from '../../../../utils/workspaceInviteActions'

// POST /api/user/invites/:inviteId/accept — accept an invitation
// addressed to the signed-in user's account email. Creates the
// workspace membership with the invited role (an existing membership is
// left as it is) and deletes the invite. 404 when the invite isn't
// addressed to this account, is expired, or doesn't exist.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const selector = await inAppInviteSelector(event, session.user.id)
  return acceptInviteForUser(event, session.user.id, selector)
})
