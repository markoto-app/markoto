import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { getWorkspaceRole } from '../workspaces/workspaceAccess'
import { getMemberRoleIgnoringSso, getMembershipRole } from '../../repos/workspaceMembers'
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

export interface WorkspaceSelfOptions extends WorkspacePolicyOptions {
  /**
   * The path parameter naming a user (parsed to a number). When it is the
   * caller, `need` is waived: any member, and a guest of the workspace, may
   * act on themselves (leave). Acting on anyone else needs `need`.
   */
  orSelf: string
}

export interface WorkspaceCtx {
  user: ValidatedUser
  wsId: string
  role: WorkspaceRole
}

export interface WorkspaceSelfCtx {
  user: ValidatedUser
  wsId: string
  /** `'guest'` only when a guest acts on themselves. */
  role: WorkspaceRole | 'guest'
  /** The target user (the `orSelf` parameter). */
  targetUserId: number
  isSelf: boolean
}

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3 }
const NEED_RANK: Record<WorkspaceNeed, number> = { member: 1, editor: 2, admin: 3 }

/** Pure: does `role` satisfy `need`? Unknown values never do. */
function workspaceRoleSatisfies(role: WorkspaceRole | null, need: WorkspaceNeed): boolean {
  if (role === null || !Object.hasOwn(RANK, role) || !Object.hasOwn(NEED_RANK, need)) return false
  return RANK[role] >= NEED_RANK[need]
}

export function workspacePolicy(need: WorkspaceNeed, o: WorkspaceSelfOptions, gate: (event: H3Event) => Promise<PolicyGate>): Policy<WorkspaceSelfCtx>
export function workspacePolicy(need: WorkspaceNeed, o: WorkspacePolicyOptions | undefined, gate: (event: H3Event) => Promise<PolicyGate>): Policy<WorkspaceCtx>
export function workspacePolicy(
  need: WorkspaceNeed,
  o: WorkspacePolicyOptions | WorkspaceSelfOptions | undefined,
  gate: (event: H3Event) => Promise<PolicyGate>
): Policy<WorkspaceCtx> | Policy<WorkspaceSelfCtx> {
  if (!Object.hasOwn(NEED_RANK, need)) throw new Error(`allow.workspace: unknown need ${String(need)}`)
  if (o && 'orSelf' in o) return selfPolicy(need, o, gate)
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

async function roleIn(wsId: string, userId: number, o: WorkspacePolicyOptions | undefined): Promise<WorkspaceRole | null> {
  return o?.ignoreSso ? getMemberRoleIgnoringSso(wsId, userId) : getWorkspaceRole(userId, wsId)
}

function selfPolicy(need: WorkspaceNeed, o: WorkspaceSelfOptions, gate: (event: H3Event) => Promise<PolicyGate>): Policy<WorkspaceSelfCtx> {
  if (typeof o.orSelf !== 'string' || o.orSelf === '') throw new Error('allow.workspace: orSelf needs a parameter name')
  return {
    kind: 'workspace',
    sessionless: false,
    need,
    gate,
    resolve: async (event: H3Event, g: PolicyGate, input: ResolveInput) => {
      if (!g.user) throw apiError('auth/required')
      const wsId = input.params?.wsId
      if (typeof wsId !== 'string' || wsId === '') throw apiError('request/invalid', { field: 'wsId' })
      // Only a parsed (numeric) parameter counts: a raw string never equals the caller's id.
      const target = input.params?.[o.orSelf]
      if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0) throw apiError('request/invalid', { field: o.orSelf })
      const isSelf = target === g.user.id
      const role = await roleIn(wsId, g.user.id, o)
      if (role === null) {
        // A guest has no workspace role but may still act on themselves.
        if (isSelf && (await getMembershipRole(wsId, g.user.id)) === 'guest') {
          return { user: g.user, wsId, role: 'guest' as const, targetUserId: target, isSelf }
        }
        throw apiError('workspace/not-found')
      }
      if (!isSelf && !workspaceRoleSatisfies(role, need)) throw denyError(o.deny ?? 'auth/forbidden')
      return { user: g.user, wsId, role, targetUserId: target, isSelf }
    }
  }
}
