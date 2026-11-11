import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { getWorkspaceRole } from '../workspaces/workspaceAccess'
import { getMemberRoleIgnoringSso } from '../../repos/workspaceMembers'
import { ssoRequiredError } from '../sso/required'
import { apiError, denyError, type DenyCode } from './apiError'
import type { PolicyGate, Policy, ResolveInput, ValidatedUser } from './policyTypes'
import type { WorkspaceRole } from '~~/shared/utils/documents/docPermissions'

// `allow.workspace(need)`: a role in the workspace named by the `wsId` path
// parameter. Guests are invisible to both role lookups, so a guest never
// passes. No role at all answers 404, never 403, so an outsider who only
// knows the id can't learn that the workspace exists.

export type WorkspaceNeed = 'member' | 'editor' | 'admin'

export interface WorkspacePolicyOptions {
  /** Ignore the SSO condition (the SSO settings themselves: the admins' break-glass). */
  ignoreSso?: true
  /** A member without a current SSO sign-in gets 403 `sso/required` with the sign-in link instead of 404. */
  ssoHint?: true
  /** Code for "role too low" (403); default `auth/forbidden`. */
  deny?: DenyCode
}

export interface WorkspaceCtx {
  user: ValidatedUser
  wsId: string
  role: WorkspaceRole
}

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3 }
const NEED_RANK: Record<WorkspaceNeed, number> = { member: 1, editor: 2, admin: 3 }

/** Pure: does `role` satisfy `need`? Unknown values never do. */
function workspaceRoleSatisfies(role: WorkspaceRole | null, need: WorkspaceNeed): boolean {
  if (role === null || !Object.hasOwn(RANK, role) || !Object.hasOwn(NEED_RANK, need)) return false
  return RANK[role] >= NEED_RANK[need]
}

export function workspacePolicy(
  need: WorkspaceNeed,
  o: WorkspacePolicyOptions | undefined,
  gate: (event: H3Event) => Promise<PolicyGate>
): Policy<WorkspaceCtx> {
  if (!Object.hasOwn(NEED_RANK, need)) throw new Error(`allow.workspace: unknown need ${String(need)}`)
  return {
    kind: 'workspace',
    sessionless: false,
    need,
    gate,
    resolve: async (event: H3Event, g: PolicyGate, input: ResolveInput) => {
      if (!g.user) throw apiError('auth/required')
      const raw = input.params?.wsId ?? getRouterParam(event, 'wsId')
      if (typeof raw !== 'string' || raw === '') throw apiError('request/invalid', { field: 'wsId' })
      const wsId = raw
      const role = o?.ignoreSso
        ? await getMemberRoleIgnoringSso(wsId, g.user.id)
        : await getWorkspaceRole(g.user.id, wsId)
      if (role === null) {
        if (o?.ssoHint) {
          const sso = await ssoRequiredError(wsId, g.user.id, `/w/${wsId}`)
          if (sso) throw sso
        }
        throw apiError('workspace/not-found')
      }
      if (!workspaceRoleSatisfies(role, need)) throw denyError(o?.deny ?? 'auth/forbidden')
      return { user: g.user, wsId, role }
    }
  }
}
