import { eq } from 'drizzle-orm'
import { folders } from '../../db/schema'
import { useDatabase } from '../../db/client'

// Access bootstrap: which scope a folder belongs to (a workspace, or one
// user's personal documents), read BEFORE any proof exists. Only the access
// layer (server/utils/access/**) imports it; it turns the answer into a
// workspace proof or the owner's own scope.

export async function getFolderScope(folderId: string): Promise<{ workspaceId: string | null, ownerId: number | null } | null> {
  return (await useDatabase()
    .select({ workspaceId: folders.workspaceId, ownerId: folders.ownerId })
    .from(folders)
    .where(eq(folders.folderId, folderId))
    .limit(1))[0] ?? null
}
