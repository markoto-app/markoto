import { eq, sql } from 'drizzle-orm'
import { workspaces, documents, workspaceMembers } from '../../db/schema'

// Per-user workspace list for the dashboard. Returns every workspace the
// user is a member of (any role), joined with the doc aggregates so the
// client can render counts + "last activity" on each card in a single
// round-trip. The member's role is returned so the UI can tag "Shared" /
// "Viewer" / etc. without a second fetch.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const db = useDatabase()
  const userId = session.user.id

  const rows = await db.select({
    workspaceId: workspaces.workspaceId,
    name: workspaces.name,
    description: workspaces.description,
    createdAt: workspaces.createdAt,
    role: workspaceMembers.role,
    docCount: sql<number>`count(${documents.docId})::int`,
    lastActive: sql<Date | null>`max(${documents.lastActive})`
  })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .leftJoin(documents, eq(documents.workspaceId, workspaces.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .groupBy(
      workspaces.workspaceId,
      workspaces.name,
      workspaces.description,
      workspaces.createdAt,
      workspaceMembers.role
    )
    .orderBy(sql`coalesce(max(${documents.lastActive}), ${workspaces.createdAt}) desc`)

  return rows
})
