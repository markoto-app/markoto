import { defineScimHandler, listScimUsers, parseScimFilter, scimError, scimUserResource, SCIM_LIST_SCHEMA } from '../../../../utils/sso/scim'

// GET /scim/v2/Users?filter=userName eq "x"&startIndex=1&count=100 (WP14)
export default defineScimHandler(async (event, connection) => {
  const q = getQuery(event)
  const filter = parseScimFilter(typeof q.filter === 'string' ? q.filter : undefined)
  if (filter === 'unsupported') throw scimError(400, 'Only "userName eq", "externalId eq" and "emails eq" filters are supported.', 'invalidFilter')
  const startIndex = Math.max(1, Number(q.startIndex) || 1)
  const count = q.count === undefined ? 100 : Math.max(0, Number(q.count) || 0)
  const { total, rows } = await listScimUsers(connection.id, { filter, startIndex, count })
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map(r => scimUserResource(event, r))
  }
})
