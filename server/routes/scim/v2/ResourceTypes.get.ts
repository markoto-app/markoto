import { defineScimHandler, SCIM_USER_SCHEMA } from '../../../utils/sso/scim'

// GET /scim/v2/ResourceTypes — only User, no Groups.
export default defineScimHandler(async () => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: 1,
  Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA }]
}))
