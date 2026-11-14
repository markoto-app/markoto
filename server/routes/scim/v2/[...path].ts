import { scimError } from '../../../utils/sso/scimErrors'

// Every other path under /scim/v2 (Groups, Schemas, Bulk, …): identity
// providers probe endpoints we don't have and expect a SCIM error object
// (RFC 7644 §3.12) back, not the app's JSON 404. Without a valid token the
// answer is the SCIM 401, like every route here.
export default defineApiHandler({
  access: allow.scim(),
  handler: async () => {
    throw scimError(404, 'This endpoint is not supported. Only Users can be provisioned.')
  }
})
