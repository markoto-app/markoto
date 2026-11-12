// The access proofs as the rest of the server sees them: the types repo
// functions demand, `system(name)` for named background jobs, and helpers
// that read a proof. Minting user, workspace and document proofs is the
// access layer's job (`server/utils/access/**`, the only importer of
// `./mint.ts`).

import type { Actor, AdminActor, DocAccess, SystemActor, UserScope, WorkspaceAccess } from './mint'

export { system } from './mint'
export type {
  Actor,
  AdminActor,
  DocAccess,
  DocGrant,
  DocLevel,
  SystemActor,
  UserScope,
  WorkspaceAccess,
  WorkspaceGrant,
  WorkspaceLevel,
  WorkspaceMemberRole
} from './mint'

/** Any proof (every level of a document or workspace proof is assignable to the bare type). */
export type AnyProof = DocAccess | WorkspaceAccess | UserScope | AdminActor | SystemActor

/** The user behind an actor (user or admin), or null for anonymous callers and jobs. */
export function actorUserId(actor: Actor): number | null {
  return actor.kind === 'user' || actor.kind === 'admin' ? actor.userId : null
}

/** The user behind a proof's actor, or null (see `actorUserId`). */
export function proofUserId(proof: { readonly actor: Actor }): number | null {
  return actorUserId(proof.actor)
}
