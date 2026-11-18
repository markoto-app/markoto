import type { DocAccess, SystemActor, UserScope, WorkspaceAccess } from '../../repos/proofs'
import { proveWorkspaceAccess } from './workspaceAccess'
import { proveNewDoc } from './docProof'

// The import worker acts for the user who started the job, with that user's
// rights as they are NOW: a workspace import needs their admin or editor role
// at the time each job runs (re-checked when a job is picked up), and the
// documents it creates are theirs.

export interface ImportJobProofs {
  owner: UserScope
  /** The target scope: the workspace proof, or the owner's own scope for personal documents. */
  scope: WorkspaceAccess<'editor'> | UserScope
  /** Every right on a document the worker has just created for the owner. */
  newDoc: (docId: string) => DocAccess<'manage' | 'share' | 'delete'>
}

/** Null when the owner can no longer write to the job's workspace. */
export async function proveImportJobScope(by: SystemActor, job: { userId: number, workspaceId: string | null }): Promise<ImportJobProofs | null> {
  const owner = by.actingFor(job.userId)
  let scope: WorkspaceAccess<'editor'> | UserScope = owner
  if (job.workspaceId !== null) {
    const ws = await proveWorkspaceAccess(job.userId, job.workspaceId, 'editor')
    if (!ws) return null
    scope = ws
  }
  return { owner, scope, newDoc: docId => proveNewDoc(owner, docId) }
}
