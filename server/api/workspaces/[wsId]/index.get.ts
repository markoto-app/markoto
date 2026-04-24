import { getWorkspace } from '../../../repos/workspaces'
import { listWorkspaceDocsWithOwnerFlag } from '../../../repos/documents'
import { listMembers } from '../../../repos/workspaceMembers'

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
  const userId = session.user.id

  const ws = await getWorkspace(wsId)
  if (!ws) throw createError({ statusCode: 404, message: 'Workspace not found' })

  const myRole = await getWorkspaceRole(userId, wsId)
  if (myRole === null) {
    // Not a member. Return 404 rather than 403 so membership itself isn't
    // enumerable by an outsider who only knows the workspace id.
    throw createError({ statusCode: 404, message: 'Workspace not found' })
  }

  const [documents, members] = await Promise.all([
    listWorkspaceDocsWithOwnerFlag(wsId, userId),
    listMembers(wsId)
  ])

  return {
    workspace: {
      workspaceId: ws.workspaceId,
      name: ws.name,
      description: ws.description,
      createdAt: ws.createdAt,
      myRole,
      ownerId: ws.ownerId,
      // (+) team-billing state. Surfaced to all members so viewers/
      // editors can see "AI usage billed to {owner}" banners; only
      // admins can TOGGLE via PATCH /billing.
      aiEnabled: ws.aiEnabled,
      billingOwnerId: ws.billingOwnerId
    },
    documents,
    members
  }
})
