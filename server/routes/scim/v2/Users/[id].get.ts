import { defineScimHandler, getScimUser, requireScimIdentity, scimUserResource } from '../../../../utils/sso/scim'

// GET /scim/v2/Users/:id (WP14)
export default defineScimHandler(async (event, connection) => {
  const identity = await requireScimIdentity(connection, getRouterParam(event, 'id'))
  return scimUserResource(event, (await getScimUser(connection.id, identity.id))!)
})
