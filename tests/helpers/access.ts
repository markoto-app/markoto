// Proofs for tests that call repo functions directly. Production code gets
// its proofs from the access layer (policies, MCP wrapper, AI tools); a test
// that seeds its own rows needs one for them, minted here through the
// test-only mint (`server/repos/proofs/testing.ts`, refused outside tests/**).
//
// Pass a `userId` when the test checks the recorded actor (audit rows);
// without one the proof is held by the `test-harness` system actor.

import {
  system,
  type AdminActor,
  type DocAccess,
  type DocLevel,
  type SystemActor,
  type UserScope,
  type WorkspaceAccess,
  type WorkspaceLevel,
  type WorkspaceMemberRole
} from '../../server/repos/proofs'
import {
  __mintAdminActor,
  __mintDocLookup,
  __mintUserScope,
  __mintWorkspaceAccess,
  __userActor
} from '../../server/repos/proofs/testing'

/** The `test-harness` system actor. */
export function sys(): SystemActor {
  return system('test-harness')
}

/** Every level on a document (view … delete), held by `userId` or the test harness. */
export function docAs(docId: string, userId?: number | null): DocAccess<DocLevel> {
  if (userId === undefined) return sys().doc(docId)
  const proof = __mintDocLookup(__userActor(userId), docId, ['manage', 'share', 'delete'])
  if (proof.allows('manage') && proof.allows('share') && proof.allows('delete')) return proof
  throw new Error('docAs: mint lost a level')
}

/** Only the given levels on a document, for tests that check a repo refuses a weaker proof. */
export function docWith(docId: string, levels: DocLevel[], userId: number | null = null): DocAccess {
  return __mintDocLookup(__userActor(userId), docId, levels)
}

/** Admin rights on a workspace, held by `userId` (as a workspace admin) or the test harness. */
export function wsAs(workspaceId: string, userId?: number): WorkspaceAccess<WorkspaceLevel> {
  if (userId === undefined) return sys().workspace(workspaceId)
  return __mintWorkspaceAccess(__userActor(userId), workspaceId, 'admin', 'admin')
}

/** A member's workspace proof for a specific role. */
export function wsRole(workspaceId: string, userId: number, role: WorkspaceMemberRole): WorkspaceAccess<'member'> {
  return __mintWorkspaceAccess(__userActor(userId), workspaceId, role, 'member')
}

/** The user acting on their own data. */
export function asUser(userId: number): UserScope {
  return __mintUserScope(userId)
}

/** An instance admin. */
export function adminAs(userId: number): AdminActor {
  return __mintAdminActor(userId)
}
