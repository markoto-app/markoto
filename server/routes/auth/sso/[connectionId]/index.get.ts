import { getSsoConnectionById } from '../../../../repos/sso'
import { getMemberRoleIgnoringSso } from '../../../../repos/workspaceMembers'
import { buildOidcAuthorizationRequest, getOidcConfiguration } from '../../../../utils/oidc/client'
import { isSafeReturnTo, type SsoFlow } from '../../../../utils/sso/flowCookie'
import { oidcSettingsForConnection, setSsoFlowCookie, ssoErrorPath } from '../../../../utils/sso/http'
import { newSamlRequestId, samlFor } from '../../../../utils/sso/saml'

// GET /auth/sso/:connectionId — start a sign-in through a workspace's
// identity provider. `?test=1` = an admin testing a draft
// connection (a successful test activates it); `?returnTo=/path` = where
// to land afterwards (same-site paths only).
//
// OIDC: state + nonce + PKCE in the signed flow cookie, 302 to the IdP.
// SAML: an AuthnRequest with an id we choose (kept in the flow cookie,
// so the response can only answer THIS browser's request), 302 to the
// IdP's SSO URL (HTTP-Redirect binding).
export default defineEventHandler(async (event) => {
  const connectionId = getRouterParam(event, 'connectionId') ?? ''
  const connection = /^[\w-]{1,64}$/.test(connectionId) ? await getSsoConnectionById(connectionId) : null
  if (!connection) throw createError({ statusCode: 404, message: 'Unknown sign-in link.', data: { code: 'sso/unknown' } })

  const query = getQuery(event)
  const flow: SsoFlow = { connectionId: connection.id, purpose: 'login' }
  if (query.test === '1') {
    const session = await requireValidatedUserSession(event)
    if ((await getMemberRoleIgnoringSso(connection.workspaceId, session.user.id)) !== 'admin') {
      throw createError({ statusCode: 403, message: 'Only an admin of the workspace can test its sign-in.', data: { code: 'sso/test-not-admin' } })
    }
    flow.purpose = 'test'
    flow.testUserId = session.user.id
  } else if (connection.status !== 'active') {
    return sendRedirect(event, ssoErrorPath('sso/not-active', connection.workspaceId))
  }
  if (typeof query.returnTo === 'string' && isSafeReturnTo(query.returnTo)) flow.returnTo = query.returnTo

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
})
