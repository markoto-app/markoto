import { getSsoConnectionById } from '../../../../repos/sso'
import { getMemberRoleIgnoringSso } from '../../../../repos/workspaceMembers'
import { buildOidcAuthorizationRequest, getOidcConfiguration } from '../../../../utils/oidc/client'
import { isSafeReturnTo, type SsoFlow } from '../../../../utils/sso/flowCookie'
import { oidcSettingsForConnection, setSsoFlowCookie, ssoErrorPath } from '../../../../utils/sso/http'
import { newSamlRequestId, samlFor } from '../../../../utils/sso/saml'
import { ID_RE } from '~~/shared/config/identifiers'
import { ssoConnectionParams, startSsoSignInQuery } from '~~/shared/api/sso'

// GET /auth/sso/:connectionId — start a sign-in through a workspace's
// identity provider. `?test=1` = an admin testing a draft
// connection (a successful test activates it); `?returnTo=/path` = where
// to land afterwards (same-site paths only).
//
// OIDC: state + nonce + PKCE in the signed flow cookie, 302 to the IdP.
// SAML: an AuthnRequest with an id we choose (kept in the flow cookie,
// so the response can only answer THIS browser's request), 302 to the
// IdP's SSO URL (HTTP-Redirect binding).
/**
 * Testing a draft connection activates it on success: workspace admins only,
 * by raw membership (the connection under test isn't enforced yet, and an
 * admin must be able to re-test a broken one).
 */
async function requireTestingAdmin(wsId: string, user: { id: number } | null): Promise<number> {
  if (!user) throw apiError('auth/required')
  if ((await getMemberRoleIgnoringSso(wsId, user.id)) !== 'admin') throw apiError('sso/test-not-admin')
  return user.id
}

export default defineApiHandler({
  access: allow.public('starts a sign-in, so the caller usually has no session yet; `?test=1` requires a signed-in admin of the workspace (checked below)', { session: 'optional' }),
  params: ssoConnectionParams,
  query: startSsoSignInQuery,
  handler: async ({ event, user, params, query }) => {
    const { connectionId } = params
    const connection = ID_RE.test(connectionId) ? await getSsoConnectionById(connectionId) : null
    if (!connection) throw apiError('sso/unknown')

    const flow: SsoFlow = { connectionId: connection.id, purpose: 'login' }
    if (query.test === '1') {
      flow.purpose = 'test'
      flow.testUserId = await requireTestingAdmin(connection.workspaceId, user)
    } else if (connection.status !== 'active') {
      return sendRedirect(event, ssoErrorPath('sso/not-active', connection.workspaceId))
    }
    if (query.returnTo !== undefined && isSafeReturnTo(query.returnTo)) flow.returnTo = query.returnTo

    if (connection.protocol === 'oidc') {
      const settings = oidcSettingsForConnection(event, connection)
      let config
      try {
        config = await getOidcConfiguration(settings)
      } catch (err) {
        console.warn(`[auth/sso] OIDC discovery failed for connection ${connection.id}: ${err instanceof Error ? err.message : 'unknown error'}`)
        return sendRedirect(event, ssoErrorPath('sso/idp-unavailable', connection.workspaceId))
      }
      const { url, flow: oidcFlow } = await buildOidcAuthorizationRequest(config, settings, settings.redirectUrl!)
      setSsoFlowCookie(event, { ...flow, ...oidcFlow })
      return sendRedirect(event, url.href)
    }

    const requestId = newSamlRequestId()
    const url = await samlFor(event, connection, { requestId }).getAuthorizeUrlAsync('', undefined, {})
    setSsoFlowCookie(event, { ...flow, requestId })
    return sendRedirect(event, url)
  }
})
