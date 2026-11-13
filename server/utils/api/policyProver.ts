import { proveDocMembership } from '../access/docProof'
import { proveWorkspaceAccess } from '../access/workspaceAccess'
import type { DocAccess, DocGrant, WorkspaceAccess, WorkspaceGrant, WorkspaceLevel } from '../../repos/proofs'

// `ctx.prove`: proofs for objects a handler reaches BEYOND the one its policy
// proved (the target workspace of a move or a copy, the workspace behind a
// document, a document named in the body). The prover is bound to the user
// the policy authenticated, so a handler names only the object, never whose
// access is checked: it cannot prove anything for anyone but its caller.

export interface SecondObjectProver {
  /**
   * The caller's role in another workspace (SSO-checked; guests have none),
   * as a proof of at least `need`. Null without such a role.
   */
  workspace<N extends WorkspaceLevel>(workspaceId: string, need: N): Promise<WorkspaceAccess<WorkspaceGrant<N>> | null>
  /**
   * The caller's membership grant on another document: `view` = owner or any
   * workspace role, `edit` = owner, workspace admin or editor, `manage` =
   * owner or workspace admin (access mode not considered). Null when missing
   * or not granted.
   */
  doc<K extends 'view' | 'edit' | 'manage'>(docId: string, kind: K): Promise<DocAccess<DocGrant<K>> | null>
}

/** The prover for the user a policy has just authenticated (`gate.user.id`, never input). */
export function proverFor(userId: number): SecondObjectProver {
  return Object.freeze({
    workspace: <N extends WorkspaceLevel>(workspaceId: string, need: N) => proveWorkspaceAccess(userId, workspaceId, need),
    doc: async <K extends 'view' | 'edit' | 'manage'>(docId: string, kind: K) => (await proveDocMembership(userId, docId, kind))?.access ?? null
  })
}
