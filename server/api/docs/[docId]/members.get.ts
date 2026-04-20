import { and, eq, sql } from 'drizzle-orm'
import { documents, workspaceMembers, users } from '../../../db/schema'

// Access roster for a doc. Used by the in-doc presence bar to render
// everyone who HAS access, not just who's live. Non-live members render
// at reduced opacity with a role tooltip.
//
// Visibility:
//   - Caller must be a workspace member of the doc's workspace, OR the doc
//     owner. Anonymous + non-member logged-in users get an empty roster —
//     a public-link doc shouldn't reveal the team roster. This matches
//     Google Docs behavior (link-holders don't see the sharing list).
//
// Standalone docs (no workspaceId) return an empty roster. The doc owner is
// already implicit and showing just themselves offline is clutter.

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)
  const db = useDatabase()

  const doc = (await db
    .select({ workspaceId: documents.workspaceId, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })

  // No workspace ⇒ no roster to disclose.
  if (!doc.workspaceId) return { members: [] }

  const userId = session?.user?.id
  if (typeof userId !== 'number') return { members: [] }

  // Must be either a workspace member or the doc owner (who may have been
  // booted from the workspace but still owns the doc).
  const role = await getWorkspaceRole(userId, doc.workspaceId)
  const isDocOwner = doc.ownerId === userId
  if (role === null && !isDocOwner) return { members: [] }

  const rows = await db.select({
    userId: users.id,
    name: users.name,
    avatarUrl: users.avatarUrl,
    login: users.login,
    role: workspaceMembers.role,
    isDocOwner: sql<boolean>`${users.id} = ${doc.ownerId}`
  })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, doc.workspaceId))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`)

  return { members: rows }
})
