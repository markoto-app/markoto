import { getSsoConnectionForWorkspace } from '../../../../repos/sso'
import { requireSsoAdmin, ssoSettingsView } from '../../../../utils/sso/admin'

// GET /api/workspaces/:wsId/sso — the workspace's single sign-on setup
// (WP14), for its admins. Never returns the client secret, the
// certificate body or the SCIM token.
export default defineEventHandler(async (event) => {
  const { wsId } = await requireSsoAdmin(event)
  return ssoSettingsView(event, wsId, await getSsoConnectionForWorkspace(wsId))
})
