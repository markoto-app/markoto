import { findVerifiedDomainOwner, getSsoConnectionForWorkspace } from '../../../repos/sso'
import { emailDomain } from '../../../utils/sso/domains'
import { isSafeReturnTo } from '../../../utils/sso/flowCookie'

// POST /api/auth/sso/discover {email, returnTo?} -> {loginUrl} of the workspace
// that verified the address's domain and has an ACTIVE connection; 404
// `sso/no-connection` otherwise. Public (the sign-in screen), 20 / client / min.
// It reveals only that a domain uses SSO here, like any "continue with SSO" box.
export default defineEventHandler(async (event) => {
  if (!(await checkRateLimit('sso-discover', getClientRateLimitKey(event), 20, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many attempts. Try again in a minute.', data: { code: 'sso/rate-limited' } })
  }
  const body = await readBody<{ email?: unknown, returnTo?: unknown }>(event).catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().slice(0, 320) : ''
  const domain = emailDomain(email)
  const workspaceId = domain ? await findVerifiedDomainOwner(domain) : null
  const connection = workspaceId ? await getSsoConnectionForWorkspace(workspaceId) : null
  if (!connection || connection.status !== 'active') {
    throw createError({ statusCode: 404, message: 'Single sign-on isn\'t set up for this email address.', data: { code: 'sso/no-connection', messageKey: 'sso.discover.notFound' } })
  }
  const returnTo = typeof body?.returnTo === 'string' && isSafeReturnTo(body.returnTo) ? body.returnTo : null
  return { loginUrl: `/auth/sso/${connection.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}` }
})
