import { defineScimHandler } from '../../../utils/sso/scim'

// GET /scim/v2/ServiceProviderConfig (RFC 7643 §5) — what we support (WP14).
export default defineScimHandler(async () => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://markoto.app/docs/account/single-sign-on',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token from the workspace\'s single sign-on settings.', primary: true }]
}))
