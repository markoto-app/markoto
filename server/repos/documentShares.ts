import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { documentShares, documents, users, workspaces } from '../db/schema'
import { useDatabase } from '../db/client'
import { proofUserId, type DocAccess, type UserScope, type WorkspaceAccess } from './proofs'

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

export async function listSharesForDoc(doc: DocAccess<'share'> | DocAccess<'manage'>): Promise<DocShareRow[]> {
  const docId = doc.docId
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
export async function upsertShare(doc: DocAccess<'share'>, share: { userId: number, access: ShareAccess }): Promise<ShareAccess | null> {
  // The granter is whoever holds the proof: a share is always a person's act.
  const grantedByUserId = proofUserId(doc)
  if (grantedByUserId === null) throw new Error('upsertShare: a share is granted by a signed-in user')
  const args = { docId: doc.docId, userId: share.userId, access: share.access, grantedByUserId }
  return useDatabase().transaction(async (tx) => {
    const prev = (await tx.select({ access: documentShares.access }).from(documentShares)
      .where(and(eq(documentShares.docId, args.docId), eq(documentShares.userId, args.userId))).for('update').limit(1))[0]
    await tx.insert(documentShares).values(args)
      .onConflictDoUpdate({ target: [documentShares.docId, documentShares.userId], set: { access: args.access, grantedByUserId: args.grantedByUserId } })
    return prev?.access ?? null
  })
}

export async function deleteShare(doc: DocAccess<'share'> | DocAccess<'manage'>, userId: number): Promise<boolean> {
  const docId = doc.docId
  const rows = await useDatabase().delete(documentShares)
    .where(and(eq(documentShares.docId, docId), eq(documentShares.userId, userId))).returning({ docId: documentShares.docId })
  return rows.length > 0
}

/** Every share on a document (it left its workspace). Returns the guests who lost one. */
export async function deleteSharesForDoc(doc: DocAccess<'manage'>): Promise<number[]> {
  const docId = doc.docId
  const rows = await useDatabase().delete(documentShares).where(eq(documentShares.docId, docId)).returning({ userId: documentShares.userId })
  return rows.map(r => r.userId)
}

/** A guest left (or was removed from) the workspace: their shares on its documents go. */
export async function deleteSharesForUserInWorkspace(ws: WorkspaceAccess<'admin'>, userId: number): Promise<number> {
  return deleteUserSharesIn(ws.workspaceId, userId)
}

/** A guest leaving: their own shares on the workspace's documents. */
export async function deleteOwnSharesInWorkspace(self: UserScope, workspaceId: string): Promise<number> {
  return deleteUserSharesIn(workspaceId, self.userId)
}

async function deleteUserSharesIn(workspaceId: string, userId: number): Promise<number> {
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
export async function listSharedWithUser(self: UserScope): Promise<SharedWithMeRow[]> {
  const userId = self.userId
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
  return rows
}
