import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { decideDocNeed, docProofFor, getDocWithActorRole, isDocNeed, type DocAuthzRow, type DocNeed, type DocNeedGrant } from '../access/docProof'
import { proveSelf } from '../access/userProof'
import { proverFor, type SecondObjectProver } from './policyProver'
import { hasValidDocJwt, type DocJwtScope } from '../documents/docTokenVerify'
import { anonCreatorKeyMatches, readAnonCreatorKey } from '../auth/anonCreator'
import { docAuthzOf } from '../access/workspaceAccess'
import { apiError, denyError, type DenyCode } from './apiError'
import type { PolicyGate, Policy, ResolveInput, ValidatedUser } from './policyTypes'
import type { DocAccess, UserScope } from '../../repos/proofs'
import { docStateOf, type ActorState, type DocState } from '~~/shared/utils/documents/docPermissions'

// `allow.doc(need)`: access to one document, decided ONLY by the pure functions
// of shared/utils/documents/docPermissions.ts (through server/utils/access/docProof.ts)
// on a row from `getDocWithActorRole` (one query: owner, workspace role or
// guest share, SSO owner suspension, share expiry). The DocState always comes
// from `docStateOf`, so share expiry and SSO suspension can't be skipped. The
// context carries the proof (`docAccess`) the repo functions demand.

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

export interface DocCtx<A extends boolean, N extends DocNeed = DocNeed> {
  user: A extends true ? ValidatedUser | null : ValidatedUser
  docId: string
  /** Contains `anonCreatorKeyHash`: never return it (the secret-key check refuses to compile). */
  doc: DocAuthzRow
  state: DocState
  actor: ActorState
  authz: DocAuthzFlags
  /** The proof repo functions take: this document, this actor, the levels the decision granted. */
  docAccess: DocAccess<DocNeedGrant<N>>
  /** The signed-in caller acting on their own data (null for anonymous callers). */
  self: A extends true ? UserScope | null : UserScope
  /** Proofs for the caller on a second object (a target workspace, another document); null for anonymous callers. */
  prove: A extends true ? SecondObjectProver | null : SecondObjectProver
}

function readDocId(event: H3Event, input: ResolveInput, from: 'params' | 'body' | 'query', key: string): string {
  let value: unknown
  if (from === 'params') value = input.params?.[key] ?? getRouterParam(event, key)
  else if (from === 'query') value = input.query?.[key]
  else value = (input.body as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value === '') throw apiError('request/invalid', { field: key })
  return value
}

export function docPolicy<A extends boolean, N extends DocNeed>(
  need: N,
  o: DocPolicyOptions<A> | undefined,
  gate: (event: H3Event) => Promise<PolicyGate>
): Policy<DocCtx<A, N>> {
  if (!isDocNeed(need)) throw new Error(`allow.doc: unknown need ${String(need)}`)
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
      return {
        user: g.user as DocCtx<A, N>['user'],
        docId,
        doc: row,
        state,
        actor,
        authz: docAuthzOf(row, userId),
        docAccess: docProofFor(need, docId, row, state, actor),
        self: (g.user ? proveSelf(g.user.id) : null) as DocCtx<A, N>['self'],
        prove: (g.user ? proverFor(g.user.id) : null) as DocCtx<A, N>['prove']
      }
    }
  }
}
