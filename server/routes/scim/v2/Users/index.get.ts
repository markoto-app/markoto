import { listScimUsers, parseScimFilter, scimUserResource, SCIM_LIST_SCHEMA } from '../../../../utils/sso/scim'
import { scimError } from '../../../../utils/sso/scimErrors'
import { listScimUsersQuery } from '~~/shared/api/sso'

// GET /scim/v2/Users?filter=userName eq "x"&startIndex=1&count=100
export default defineApiHandler({
  access: allow.scim(),
  query: listScimUsersQuery,
  handler: async ({ event, connection, query }) => {
    const filter = parseScimFilter(query.filter)
    if (filter === 'unsupported') throw scimError(400, 'Only "userName eq", "externalId eq" and "emails eq" filters are supported.', 'invalidFilter')
    const { startIndex, count } = query
    const { total, rows } = await listScimUsers(connection.id, { filter, startIndex, count })
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map(r => scimUserResource(event, r))
    }
  }
})
