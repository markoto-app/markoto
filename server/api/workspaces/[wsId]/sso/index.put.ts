import { nanoid } from 'nanoid'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, upsertSsoConnection } from '../../../../repos/sso'
import { AUDIT_SSO_CONNECTION_SAVED } from '../../../../legal/auditActions'
import { parseSsoSettings, ssoSettingsView } from '../../../../utils/sso/admin'
import { MINUTE_MS } from '~~/shared/config/units'
import { updateSsoSettingsBody } from '~~/shared/api/sso'

// PUT /api/workspaces/:wsId/sso — create or change the workspace's
// identity provider. Admins of a workspace whose plan includes
// SSO (409 plan/feature-unavailable otherwise), also while SSO is enforced
// (`ignoreSso`: the break-glass). Any change to the IdP
// settings returns an active connection to `draft`: it is enforced again
// only after the next successful test sign-in, so a typo can't lock the
// workspace out. 20 saves / admin / 10 min.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  body: updateSsoSettingsBody,
  invalidCode: 'sso/invalid-settings',
  plan: { feature: 'sso', message: 'Single sign-on is part of the Business plan.' },
  rateLimit: { namespace: 'sso-settings', max: 20, windowMs: 10 * MINUTE_MS, key: 'user', error: 'sso/rate-limited' },
  handler: async ({ event, user, wsId, body }) => {
    const existing = await getSsoConnectionForWorkspace(wsId)
    // The IdP URL is checked against the SSRF policy here (and again on every use).
    const fields = await parseSsoSettings(body, existing)
    const { connection, idpChanged } = await upsertSsoConnection({ id: existing?.id ?? nanoid(16), workspaceId: wsId, createdByUserId: user.id, fields })
    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_SSO_CONNECTION_SAVED,
      metadata: { protocol: connection.protocol, created: !existing, idpChanged, status: connection.status }
    })
    return ssoSettingsView(event, wsId, connection)
  }
})
