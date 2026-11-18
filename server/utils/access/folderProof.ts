import { getFolderScope } from '../../repos/access/folderScope'
import type { UserScope, WorkspaceAccess, WorkspaceGrant } from '../../repos/proofs'
import { proveWorkspaceAccess } from './workspaceAccess'
import { proveSelf } from './userProof'

// Folder decisions. A folder carries no permissions of its own: a workspace
// folder is reached through the caller's role in its workspace (SSO-checked,
// guests have none), a personal folder only by its owner. The proof handed
// back is the scope proof the folder repos take.

export type FolderNeed = 'member' | 'editor' | 'admin'

export type FolderScopeProof<N extends FolderNeed>
  = | { kind: 'workspace', workspaceId: string, scope: WorkspaceAccess<WorkspaceGrant<N>> }
    | { kind: 'personal', workspaceId: null, scope: UserScope }

/**
 * The scope proof for a folder the user may reach at `need` (a personal
 * folder: its owner, at every level). Null when the folder does not exist,
 * is not theirs, or their role is too low: callers answer 404 either way so
 * folder ids of other workspaces can't be probed.
 */
export async function proveFolderScope<N extends FolderNeed>(userId: number, folderId: string, need: N): Promise<FolderScopeProof<N> | null> {
  const owner = await getFolderScope(folderId)
  if (!owner) return null
  if (owner.workspaceId !== null) {
    const scope = await proveWorkspaceAccess(userId, owner.workspaceId, need)
    return scope ? { kind: 'workspace', workspaceId: owner.workspaceId, scope } : null
  }
  if (owner.ownerId !== userId) return null
  return { kind: 'personal', workspaceId: null, scope: proveSelf(userId) }
}

/** The scope proof for "workspace `workspaceId`, or my personal documents when null". */
export async function proveScope<N extends FolderNeed>(userId: number, workspaceId: string | null, need: N): Promise<FolderScopeProof<N> | null> {
  if (workspaceId === null) return { kind: 'personal', workspaceId: null, scope: proveSelf(userId) }
  const scope = await proveWorkspaceAccess(userId, workspaceId, need)
  return scope ? { kind: 'workspace', workspaceId, scope } : null
}
