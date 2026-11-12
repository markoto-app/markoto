import { requireScimUser, requireScimIdentity, scimUserResource } from '../../../../utils/sso/scim'
import { scimUserParams } from '~~/shared/api/sso'

// GET /scim/v2/Users/:id
export default defineApiHandler({
  access: allow.scim(),
  params: scimUserParams,
  handler: async ({ event, connection, params }) => {
    const identity = await requireScimIdentity(connection, params.id)
    return scimUserResource(event, await requireScimUser(connection, identity.id))
  }
})
