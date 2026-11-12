import type { H3Event } from 'h3'
import { appendAuditEvent } from '../../repos/audit'
import type { SsoConnectionRow } from '../../repos/sso'
import {
  AUDIT_SSO_CONNECTION_ACTIVATED,
  AUDIT_SSO_IDENTITY_LINKED,
  AUDIT_SSO_MEMBER_JOINED,
  AUDIT_SSO_SIGN_IN
} from '../../legal/auditActions'
import { completeSsoLogin, SsoLoginRefused, type SsoAssertion } from './completeLogin'
import { afterSsoLoginPath, setSsoSession, ssoErrorPath } from './http'
import type { SsoFlow } from './flowCookie'
import { system } from '../../repos/proofs'

/**
 * The common end of both callbacks (OIDC `callback`, SAML `acs`): resolve
 * the account + membership, start the session, audit, redirect. Refusals
 * land on `/auth/sso-error?code=…` with our fixed code only.
 */
export async function finishSsoSignIn(event: H3Event, connection: SsoConnectionRow, flow: SsoFlow, assertion: SsoAssertion) {
  const ip = getClientIp(event)
  let result
  try {
    result = await completeSsoLogin(connection, assertion, flow)
  } catch (e) {
    if (e instanceof SsoLoginRefused) {
      await appendAuditEvent({
        // A test sign-in is run by the admin testing it; a real one has no user yet.
        by: flow.testUserId ? system('sso-login').actingFor(flow.testUserId) : system('sso-login'),
        actorIp: ip,
        scope: 'workspace',
        scopeId: connection.workspaceId,
        action: AUDIT_SSO_SIGN_IN,
        metadata: { protocol: connection.protocol, outcome: 'refused', code: e.code, test: flow.purpose === 'test' }
      })
      return sendRedirect(event, ssoErrorPath(e.code, connection.workspaceId))
    }
    throw e
  }

  await setSsoSession(event, result)
  // The sign-in is the user's own act; the job only carries it out.
  const base = { by: system('sso-login').actingFor(result.userId), actorIp: ip, scope: 'workspace' as const, scopeId: connection.workspaceId }
  await appendAuditEvent({ ...base, action: AUDIT_SSO_SIGN_IN, metadata: { protocol: connection.protocol, outcome: 'ok', test: flow.purpose === 'test', created: result.created } })
  if (result.linked) await appendAuditEvent({ ...base, action: AUDIT_SSO_IDENTITY_LINKED, metadata: { protocol: connection.protocol } })
  if (result.joined) await appendAuditEvent({ ...base, action: AUDIT_SSO_MEMBER_JOINED, metadata: { role: result.role, via: 'sign_in' } })
  if (result.activated) await appendAuditEvent({ ...base, action: AUDIT_SSO_CONNECTION_ACTIVATED, metadata: { protocol: connection.protocol } })
  return sendRedirect(event, afterSsoLoginPath(result, flow))
}
