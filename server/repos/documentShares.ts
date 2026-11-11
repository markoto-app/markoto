import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { documentShares, documents, users, workspaces } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// Documents shared with workspace guests. A share is the ONLY way
// a guest reaches a workspace document; `getDocWithActorRole` turns it
// into `editor` (edit) / `viewer` (view) for that one document.

export type ShareAccess = 'view' | 'edit'

export interface DocShareRow {
  userId: number
  name: string
  email: string | null
  access: ShareAccess
  createdAt: Date
}

export async function listSharesForDoc(docId: string): Promise<DocShareRow[]> {
  return useDatabase().select({
    userId: documentShares.userId,
    name: users.name,
    email: users.email,
    access: documentShares.access,
    createdAt: documentShares.createdAt
  })
    .from(documentShares)
    .innerJoin(users, eq(users.id, documentShares.userId))
    .where(eq(documentShares.docId, docId))
    .orderBy(users.name)
}

/** Create or change a share. Returns the previous access, or null when new. */
export async function upsertShare(args: { docId: string, userId: number, access: ShareAccess, grantedByUserId: number }): Promise<ShareAccess | null> {
  return useDatabase().transaction(async (tx) => {
    const prev = (await tx.select({ access: documentShares.access }).from(documentShares)
      .where(and(eq(documentShares.docId, args.docId), eq(documentShares.userId, args.userId))).for('update').limit(1))[0]
    await tx.insert(documentShares).values(args)
      .onConflictDoUpdate({ target: [documentShares.docId, documentShares.userId], set: { access: args.access, grantedByUserId: args.grantedByUserId } })
    return prev?.access ?? null
  })
}

export async function deleteShare(docId: string, userId: number): Promise<boolean> {
  const rows = await useDatabase().delete(documentShares)
    .where(and(eq(documentShares.docId, docId), eq(documentShares.userId, userId))).returning({ docId: documentShares.docId })
  return rows.length > 0
}

/** Every share on a document (it left its workspace). Returns the guests who lost one. */
export async function deleteSharesForDoc(docId: string): Promise<number[]> {
  const rows = await useDatabase().delete(documentShares).where(eq(documentShares.docId, docId)).returning({ userId: documentShares.userId })
  return rows.map(r => r.userId)
}

/** A guest left (or was removed from) the workspace: their shares on its documents go. */
export async function deleteSharesForUserInWorkspace(userId: number, workspaceId: string): Promise<number> {
  const rows = await useDatabase().delete(documentShares)
    .where(and(
      eq(documentShares.userId, userId),
      inArray(documentShares.docId, useDatabase().select({ id: documents.docId }).from(documents).where(eq(documents.workspaceId, workspaceId)))
    ))
    .returning({ docId: documentShares.docId })
  return rows.length
}

export interface SharedWithMeRow {
  docId: string
  title: string
  access: ShareAccess
  workspaceId: string
  workspaceName: string
  lastActive: Date | null
}

/**
 * Documents shared with the user AS A GUEST, newest activity
 * first. Only while they are still a guest of the document's workspace.
 */
export async function listSharedWithUser(userId: number): Promise<SharedWithMeRow[]> {
  const rows = await useDatabase().select({
    docId: documents.docId,
    title: documents.title,
    access: documentShares.access,
    workspaceId: workspaces.workspaceId,
    workspaceName: workspaces.name,
    lastActive: documents.lastActive
  })
    .from(documentShares)
    .innerJoin(documents, eq(documents.docId, documentShares.docId))
    .innerJoin(workspaces, eq(workspaces.workspaceId, documents.workspaceId))
    .where(and(
      eq(documentShares.userId, userId),
      sql`exists (select 1 from workspace_members wm where wm.workspace_id = ${documents.workspaceId} and wm.user_id = ${userId} and wm.role = 'guest')`
    ))
    .orderBy(desc(documents.lastActive))
  return rows as SharedWithMeRow[]
}
