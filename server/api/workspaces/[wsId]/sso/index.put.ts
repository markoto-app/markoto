import { nanoid } from 'nanoid'
import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, upsertSsoConnection } from '../../../../repos/sso'
import { AUDIT_SSO_CONNECTION_SAVED } from '../../../../legal/auditActions'
import { assertSsoPlan, parseSsoSettings, requireSsoAdmin, ssoSettingsView } from '../../../../utils/sso/admin'

// PUT /api/workspaces/:wsId/sso — create or change the workspace's
// identity provider (WP14). Admins of a workspace whose plan includes
// SSO (409 plan/feature-unavailable otherwise). Any change to the IdP
// settings returns an active connection to `draft`: it is enforced again
// only after the next successful test sign-in, so a typo can't lock the
// workspace out. 20 saves / admin / 10 min.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  await assertSsoPlan(wsId)
  if (!(await checkRateLimit('sso-settings', String(userId), 20, 10 * 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many changes. Try again in a few minutes.', data: { code: 'sso/rate-limited' } })
  }
  const existing = await getSsoConnectionForWorkspace(wsId)
  const fields = await parseSsoSettings(await readBody(event), existing)
  const { connection, idpChanged } = await upsertSsoConnection({ id: existing?.id ?? nanoid(16), workspaceId: wsId, createdByUserId: userId, fields })
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_SSO_CONNECTION_SAVED,
    metadata: { protocol: connection.protocol, created: !existing, idpChanged, status: connection.status }
  })
  return ssoSettingsView(event, wsId, connection)
})
