import { eq, sql } from 'drizzle-orm'
import { workspaces, documents, workspaceMembers, users } from '../../../db/schema'

// Workspace detail. Gated by membership (any role). Returns the workspace
// row, the complete doc list (every doc in the workspace — not just the
// caller's), plus the members list so the UI can render the avatar bar +
// manage-members modal in a single fetch.
//
// Per-doc ownership is surfaced via `isOwner` so the UI can gate the delete
// button for editors (who can only delete their own docs).

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const db = useDatabase()
  const userId = session.user.id

  const ws = (await db.select({
    workspaceId: workspaces.workspaceId,
    ownerId: workspaces.ownerId,
    name: workspaces.name,
    description: workspaces.description,
    createdAt: workspaces.createdAt
  })
    .from(workspaces)
    .where(eq(workspaces.workspaceId, wsId))
    .limit(1))[0]

  if (!ws) throw createError({ statusCode: 404, message: 'Workspace not found' })

  const myRole = await getWorkspaceRole(userId, wsId)
  if (myRole === null) {
    // Not a member. Return 404 rather than 403 so membership itself isn't
    // enumerable by an outsider who only knows the workspace id.
    throw createError({ statusCode: 404, message: 'Workspace not found' })
  }

  const docs = await db.select({
    docId: documents.docId,
    title: documents.title,
    accessMode: documents.accessMode,
    wordCount: documents.wordCount,
    sizeBytes: documents.sizeBytes,
    lastActive: documents.lastActive,
    ownerId: documents.ownerId,
    isOwner: sql<boolean>`${documents.ownerId} = ${userId}`
  })
    .from(documents)
    .where(eq(documents.workspaceId, wsId))
    .orderBy(sql`${documents.lastActive} desc`)

  const members = await db.select({
    userId: users.id,
    name: users.name,
    email: users.email,
    login: users.login,
    avatarUrl: users.avatarUrl,
    role: workspaceMembers.role,
    joinedAt: workspaceMembers.joinedAt
  })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, wsId))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`)

  return {
    workspace: {
      workspaceId: ws.workspaceId,
      name: ws.name,
      description: ws.description,
      createdAt: ws.createdAt,
      myRole,
      ownerId: ws.ownerId
    },
    documents: docs,
    members
  }
})
