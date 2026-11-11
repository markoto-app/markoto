import { getSsoConnectionById } from '../../../../repos/sso'
import { samlServiceProviderMetadata } from '../../../../utils/sso/saml'
import { ID_RE } from '~~/shared/config/identifiers'

// GET /auth/sso/:connectionId/metadata — our SAML service-provider
// metadata (entity id + ACS URL) for the admin to import at their IdP.
// Public by design (IdPs fetch it); contains no secret.
export default defineEventHandler(async (event) => {
  const connectionId = getRouterParam(event, 'connectionId') ?? ''
  const connection = ID_RE.test(connectionId) ? await getSsoConnectionById(connectionId) : null
  if (!connection || connection.protocol !== 'saml') throw createError({ statusCode: 404, message: 'Unknown connection.' })
  setHeader(event, 'content-type', 'application/samlmetadata+xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=300')
  return samlServiceProviderMetadata(event, connection)
})
