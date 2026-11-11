import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { getDocWithActorRole, type DocAuthzRow } from '../../repos/documents'
import { hasValidDocJwt, type DocJwtScope } from '../documents/docTokenVerify'
import { canWriteDocContent } from '../documents/documentAccess'
import { anonCreatorKeyMatches, readAnonCreatorKey } from '../auth/anonCreator'
import { docAuthzOf } from '../workspaces/workspaceAccess'
import { apiError, denyError, type DenyCode } from './apiError'
import type { PolicyGate, Policy, ResolveInput, ValidatedUser } from './policyTypes'
import {
  decideActivityAccess,
  decideDocDelete,
  decideFileAccess,
  docStateOf,
  type ActorState,
  type DocState
} from '~~/shared/utils/documents/docPermissions'

// `allow.doc(need)`: access to one document, decided ONLY by the pure functions
// of shared/utils/documents/docPermissions.ts on a row from
// `getDocWithActorRole` (one query: owner, workspace role or guest share, SSO
// owner suspension, share expiry). The DocState always comes from `docStateOf`,
// so share expiry and SSO suspension can't be skipped.

export type DocNeed = 'file' | 'activity' | 'write-content' | 'edit' | 'manage' | 'share-guests' | 'delete' | 'lookup'

export interface DocPolicyOptions<A extends boolean> {
  /** Session optional: anonymous callers reach the decision (route must be on the public allowlist). */
  anonymous?: A
  /** Where the doc id comes from; default the `docId` path parameter. */
  docId?: { from: 'params' | 'body' | 'query', key?: string }
  /** Also accept a document JWT (`Authorization: Bearer` / `?token=`): password holders, and the listed scopes. */
  jwt?: true | readonly DocJwtScope[]
  /** Code for a refusal (403); default `auth/forbidden`. */
  deny?: DenyCode
  /** Required for `lookup` (the handler decides): what it decides and why. */
  reason?: string
}

export interface DocAuthzFlags {
  isDocOwner: boolean
  /** Membership grant (owner or any workspace role), access mode not considered. */
  canView: boolean
  canEdit: boolean
  canManage: boolean
}

export interface DocCtx<A extends boolean> {
  user: A extends true ? ValidatedUser | null : ValidatedUser
  docId: string
  /** Contains `anonCreatorKeyHash`: never return it (the secret-key check refuses to compile). */
  doc: DocAuthzRow
  state: DocState
  actor: ActorState
  authz: DocAuthzFlags
}

export type DocDecision = { allow: true } | { allow: false, status: 401 | 403 }

/** `true` = allowed; `false` = 403; `401` = needs a signed-in caller. */
type Verdict = boolean | 401
type Rule = (row: DocAuthzRow, state: DocState, actor: ActorState) => Verdict

const RULES: Record<DocNeed, Rule> = {
  'lookup': () => true,
  'file': (_row, state, actor) => decideFileAccess(state, actor).outcome === 'allow',
  'activity': (_row, state, actor) => decideActivityAccess(state, actor).outcome === 'allow',
  'delete': (_row, state, actor) => {
    const d = decideDocDelete(state, actor)
    if (d.outcome === 'allow') return true
    return d.reason === 'authentication-required' ? 401 : false
  },
  'write-content': (row, _state, actor) => actor.userId === null ? 401 : canWriteDocContent(row, actor.userId),
  'edit': (row, _state, actor) => docAuthzOf(row, actor.userId).canEdit,
  'manage': (row, _state, actor) => docAuthzOf(row, actor.userId).canManage,
  // Workspace admins and editors (members, not guests) of a workspace doc.
  'share-guests': row => row.workspaceId !== null && !row.isGuest && (row.workspaceRole === 'admin' || row.workspaceRole === 'editor')
}

/**
 * Pure: may this actor do `need` on the document? Every rule delegates to a
 * docPermissions decision (or to `docAuthzOf` / `canWriteDocContent`, which
 * build on them). Unknown needs deny.
 */
export function decideDocNeed(need: DocNeed, row: DocAuthzRow, state: DocState, actor: ActorState): DocDecision {
  const verdict = Object.hasOwn(RULES, need) ? RULES[need](row, state, actor) : false
  if (verdict === true) return { allow: true }
  return { allow: false, status: verdict === 401 ? 401 : 403 }
}

function readDocId(event: H3Event, input: ResolveInput, from: 'params' | 'body' | 'query', key: string): string {
  let value: unknown
  if (from === 'params') value = input.params?.[key] ?? getRouterParam(event, key)
  else if (from === 'query') value = input.query?.[key]
  else value = (input.body as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value === '') throw apiError('request/invalid', { field: key })
  return value
}

export function docPolicy<A extends boolean>(
  need: DocNeed,
  o: DocPolicyOptions<A> | undefined,
  gate: (event: H3Event) => Promise<PolicyGate>
): Policy<DocCtx<A>> {
  if (!Object.hasOwn(RULES, need)) throw new Error(`allow.doc: unknown need ${String(need)}`)
  if (need === 'lookup' && !o?.reason?.trim()) throw new Error('allow.doc(\'lookup\') needs a reason')
  const anonymous = Boolean(o?.anonymous)
  const from = o?.docId?.from ?? 'params'
  const key = o?.docId?.key ?? 'docId'
  const scopes: readonly DocJwtScope[] | undefined = o?.jwt === true ? [] : o?.jwt
  return {
    kind: 'doc',
    sessionless: anonymous,
    need,
    reason: o?.reason,
    gate,
    resolve: async (event, g, input) => {
      if (!anonymous && !g.user) throw apiError('auth/required')
      const userId = g.user?.id ?? null
      const docId = readDocId(event, input, from, key)
      const row = await getDocWithActorRole(docId, userId)
      // Gone from the DB: deny everything, also file reads whose S3 objects outlived the row.
      if (!row) throw apiError('docs/not-found')
      const state = docStateOf(row)
      const actor: ActorState = {
        userId,
        workspaceRole: row.workspaceRole,
        isGuest: row.isGuest,
        hasValidDocJwt: scopes ? hasValidDocJwt(event, docId, scopes) : false,
        isAnonCreator: need === 'delete' ? anonCreatorKeyMatches(readAnonCreatorKey(event), row.anonCreatorKeyHash) : false
      }
      const decision = decideDocNeed(need, row, state, actor)
      if (!decision.allow) throw decision.status === 401 ? apiError('auth/required') : denyError(o?.deny ?? 'auth/forbidden')
      return { user: g.user as DocCtx<A>['user'], docId, doc: row, state, actor, authz: docAuthzOf(row, userId) }
    }
  }
}
