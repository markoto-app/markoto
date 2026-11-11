import { findVerifiedDomainOwner, getSsoConnectionForWorkspace } from '../../../repos/sso'
import { emailDomain } from '../../../utils/sso/domains'
import { isSafeReturnTo } from '../../../utils/sso/flowCookie'
import { MINUTE_MS } from '~~/shared/config/units'
import { discoverSsoBody } from '~~/shared/api/sso'

// POST /api/auth/sso/discover {email, returnTo?} -> {loginUrl} of the workspace
// that verified the address's domain and has an ACTIVE connection; 404
// `sso/no-connection` otherwise. Public (the sign-in screen), 20 / client / min.
// It reveals only that a domain uses SSO here, like any "continue with SSO" box:
// every other outcome (no address, unknown or unverified domain, draft
// connection) is the same 404.
export default defineApiHandler({
  access: allow.public('the sign-in screen asks before anyone is signed in; rate-limited per client, answers only whether a verified domain has an active connection'),
  body: discoverSsoBody,
  rateLimit: { namespace: 'sso-discover', max: 20, windowMs: MINUTE_MS, key: 'ip', error: 'sso/rate-limited' },
  handler: async ({ body }) => {
    const email = body?.email?.trim().slice(0, 320) ?? ''
    const domain = emailDomain(email)
    const workspaceId = domain ? await findVerifiedDomainOwner(domain) : null
    const connection = workspaceId ? await getSsoConnectionForWorkspace(workspaceId) : null
    if (!connection || connection.status !== 'active') throw apiError('sso/no-connection')
    const returnTo = body?.returnTo !== undefined && isSafeReturnTo(body.returnTo) ? body.returnTo : null
    return { loginUrl: `/auth/sso/${connection.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}` }
  }
})
