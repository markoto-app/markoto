import { getSsoConnectionForWorkspace } from '../../../../repos/sso'
import { ssoSettingsView } from '../../../../utils/sso/admin'

// GET /api/workspaces/:wsId/sso: the workspace's single sign-on setup
// for its admins. Never returns the client secret, the
// certificate body or the SCIM token. Admins keep this page while SSO is
// enforced (`ignoreSso`): they must be able to repair a broken IdP.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  handler: async ({ event, wsId, workspaceAccess }) => ssoSettingsView(event, workspaceAccess, await getSsoConnectionForWorkspace(wsId))
})
