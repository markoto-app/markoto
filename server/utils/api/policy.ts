import type { H3Event } from 'h3'
import { getHeader, getQuery, setHeader } from 'h3'
import { getValidatedUserSession, requireValidatedUserSession } from '../auth/validatedSession'
import { requireAdminUser } from '../auth/adminAccess'
import { rejectIfFromEdge, requireInternalSecret } from '../platform/internalRoutes'
import { verifyRenderToken } from '../rendering/renderTokens'
import { traefikProviderSettings, type TraefikProviderSettings } from '../customDomains/config'
import { requireScimConnection } from '../sso/scim'
import { scimErrorFormat } from '../sso/scimErrors'
import type { SsoConnectionRow } from '../../repos/sso'
import { apiError } from './apiError'
import { docPolicy, type DocNeed, type DocPolicyOptions, type DocCtx } from './policyDoc'
import { workspacePolicy, type WorkspaceNeed, type WorkspacePolicyOptions, type WorkspaceCtx, type WorkspaceSelfOptions, type WorkspaceSelfCtx } from './policyWorkspace'
import type { Policy, PolicyGate, ResolveInput, ValidatedUser, AdminIdentity } from './policyTypes'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { matchesCurrentOrPrevious } from '~~/shared/utils/security/internalSecret'
import type { RenderJwtPayload } from '~~/shared/contracts/jwt'

// Access policies: every route declares WHO may call it as `access: allow.*()`
// (server/utils/api/defineApiHandler.ts runs it). A policy has two phases:
// `gate` (session and service credentials, before any input is read) and
// `resolve` (object-level access once params, query and body are parsed). Both
// throw to deny; neither may return a context for a caller it does not admit.
//
// `sessionless` must be true exactly for the routes on the middleware's public
// allowlist (server/utils/auth/publicRoutes.ts); tests/unit/platform/apiRoutes.test.ts
// holds the two lists together.

export type InternalVia = 'secret' | 'traefik-token' | 'render-token'

export interface InternalCtx {
  user: null
  /** `render-token`: the verified claims (`docId` from the query). */
  render?: RenderJwtPayload
  /** `traefik-token`: the provider settings, or null when the instance runs no custom domains (then any caller gets the empty answer). */
  traefik?: TraefikProviderSettings | null
}

const NO_USER: PolicyGate = { user: null }

function nonEmpty(reason: string, what: string): string {
  // A public or custom route must say why; the route test checks the literal too.
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`allow.${what}() needs a reason`)
  return reason
}

function publicPolicy(reason: string): Policy<{ user: null }>
function publicPolicy(reason: string, o: { session: 'optional' }): Policy<{ user: ValidatedUser | null }>
function publicPolicy(reason: string, o?: { session: 'optional' }): Policy<{ user: ValidatedUser | null }> {
  const optional = o?.session === 'optional'
  return {
    kind: 'public',
    sessionless: true,
    reason: nonEmpty(reason, 'public'),
    // Without `session: 'optional'` the session is never read, so an anonymous
    // request can't end up with a cookie (plugins/session-cookie.ts).
    gate: async event => optional ? { user: (await getValidatedUserSession(event))?.user ?? null } : NO_USER,
    resolve: async (_event, gate) => ({ user: gate.user })
  }
}

const userGate = async (event: H3Event): Promise<PolicyGate> => ({ user: (await requireValidatedUserSession(event)).user })

function signedIn(gate: PolicyGate): ValidatedUser {
  // A gate that admitted no user to a session-only policy is a wiring bug: deny.
  if (!gate.user) throw apiError('auth/required')
  return gate.user
}

function userPolicy(): Policy<{ user: ValidatedUser }> {
  return {
    kind: 'user',
    sessionless: false,
    gate: userGate,
    resolve: async (_event, gate) => ({ user: signedIn(gate) })
  }
}

function adminPolicy(): Policy<{ user: ValidatedUser, admin: AdminIdentity }> {
  return {
    kind: 'admin',
    sessionless: false,
    // 401 without a session, 403 `admin/forbidden` without the flag, both before any input is read.
    gate: async (event) => {
      const { user } = await requireValidatedUserSession(event)
      return { user, admin: await requireAdminUser(event) }
    },
    resolve: async (_event, gate) => {
      if (!gate.admin) throw apiError('admin/forbidden')
      return { user: signedIn(gate), admin: gate.admin }
    }
  }
}

function internalPolicy(via: InternalVia): Policy<InternalCtx> {
  return {
    kind: 'internal',
    sessionless: true,
    reason: via,
    gate: async (event) => {
      // The middleware already applies both checks to /api/internal/**;
      // repeated here so the route stays closed if it is ever moved.
      rejectIfFromEdge(event)
      if (via === 'secret') requireInternalSecret(event)
      return NO_USER
    },
    resolve: async (event) => {
      if (via === 'secret') return { user: null }
      if (via === 'traefik-token') {
        // Set before the token check so the 403 is never cached either.
        setHeader(event, 'cache-control', 'no-store')
        const settings = traefikProviderSettings()
        if (settings && !matchesCurrentOrPrevious(getHeader(event, 'x-markoto-provider-token') ?? '', settings.token)) {
          throw apiError('internal/forbidden')
        }
        return { user: null, traefik: settings }
      }
      if (via === 'render-token') {
        const { docId, t } = getQuery(event)
        if (typeof docId !== 'string' || !docId || typeof t !== 'string' || !t) {
          throw apiError('request/invalid', { field: typeof docId === 'string' && docId ? 't' : 'docId' })
        }
        const render = verifyRenderToken(t, docId)
        if (!render) throw apiError('internal/forbidden')
        return { user: null, render }
      }
      throw apiError('internal/forbidden')
    }
  }
}

function scimPolicy(): Policy<{ user: null, connection: SsoConnectionRow }> {
  return {
    kind: 'scim',
    sessionless: true,
    // Every refusal, including the token check and input validation, leaves as a SCIM Error object.
    errorFormat: scimErrorFormat,
    gate: async event => ({ user: null, scimConnection: await requireScimConnection(event) }),
    resolve: async (_event, gate) => {
      if (!gate.scimConnection) throw apiError('auth/required')
      return { user: null, connection: gate.scimConnection }
    }
  }
}

function testOnlyPolicy(o?: { session: 'required' | 'none' }): Policy<{ user: ValidatedUser | null }> {
  const required = o?.session === 'required'
  return {
    kind: 'test-only',
    sessionless: true,
    gate: async (event) => {
      // 404 before anything else: outside test mode the route does not exist.
      if (!isTestModeEnabled()) throw apiError('resource/not-found')
      return required ? userGate(event) : NO_USER
    },
    resolve: async (_event, gate) => ({ user: required ? signedIn(gate) : gate.user })
  }
}

function customPolicy<Ctx>(reason: string, o: { sessionless: boolean, check: (event: H3Event, input: ResolveInput, gate: PolicyGate) => Promise<Ctx> }): Policy<Ctx> {
  return {
    kind: 'custom',
    sessionless: o.sessionless,
    reason: nonEmpty(reason, 'custom'),
    // A non-public custom route still requires a session before its check runs.
    gate: async event => o.sessionless ? NO_USER : userGate(event),
    resolve: async (event, gate, input) => o.check(event, input, gate)
  }
}

function workspace(need: WorkspaceNeed, o: WorkspaceSelfOptions): Policy<WorkspaceSelfCtx>
function workspace(need: WorkspaceNeed, o?: WorkspacePolicyOptions): Policy<WorkspaceCtx>
function workspace(need: WorkspaceNeed, o?: WorkspacePolicyOptions | WorkspaceSelfOptions): Policy<WorkspaceCtx> | Policy<WorkspaceSelfCtx> {
  return o && 'orSelf' in o ? workspacePolicy(need, o, userGate) : workspacePolicy(need, o, userGate)
}

function doc<const A extends boolean = false>(need: DocNeed, o?: DocPolicyOptions<A>): Policy<DocCtx<A>> {
  return docPolicy(need, o, async event => o?.anonymous
    ? { user: (await getValidatedUserSession(event))?.user ?? null }
    : userGate(event))
}

export const allow = {
  /** No session needed. `reason` says why the route is public and what gates it instead. */
  public: publicPolicy,
  /** A signed-in user. */
  user: userPolicy,
  /** An instance admin (`users.is_admin`). 403 `admin/forbidden` otherwise. */
  admin: adminPolicy,
  /** A role in the workspace of `:wsId`. No role → 404 `workspace/not-found`; too low → 403 `deny`. `orSelf`: anyone in it (guests too) acting on themselves. */
  workspace,
  /** Access to the document of `:docId` (or a body / query field), decided by shared/utils/documents/docPermissions.ts. */
  doc,
  /** Service-to-service: internal secret, Traefik provider token or render token. */
  internal: internalPolicy,
  /** A SCIM client of a workspace's SSO connection (bearer token). */
  scim: scimPolicy,
  /** Test-mode-only routes: 404 on every other instance. */
  testOnly: testOnlyPolicy,
  /** Escape hatch for a rule none of the above expresses; `reason` is reviewed like a public route. */
  custom: customPolicy
}
