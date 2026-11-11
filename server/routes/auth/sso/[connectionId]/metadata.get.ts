import { getSsoConnectionById } from '../../../../repos/sso'
import { samlServiceProviderMetadata } from '../../../../utils/sso/saml'
import { ID_RE } from '~~/shared/config/identifiers'
import { ssoConnectionParams } from '~~/shared/api/sso'

// GET /auth/sso/:connectionId/metadata — our SAML service-provider
// metadata (entity id + ACS URL) for the admin to import at their IdP.
export default defineApiHandler({
  access: allow.public('IdPs fetch the service-provider metadata unauthenticated; it holds only our entity id and ACS URL, no secret'),
  params: ssoConnectionParams,
  handler: async ({ event, params }) => {
    const connection = ID_RE.test(params.connectionId) ? await getSsoConnectionById(params.connectionId) : null
    if (!connection || connection.protocol !== 'saml') throw apiError('sso/connection-not-found')
    setHeader(event, 'content-type', 'application/samlmetadata+xml; charset=utf-8')
    setHeader(event, 'cache-control', 'public, max-age=300')
    return samlServiceProviderMetadata(event, connection)
  }
})
