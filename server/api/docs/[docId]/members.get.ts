import { getDoc } from '../../../repos/documents'
import { listMembersForDoc } from '../../../repos/workspaceMembers'

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
// Standalone docs (no workspaceId) return an empty roster. The doc owner
// is already implicit and showing just themselves offline is clutter.

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)

  const doc = await getDoc(docId)
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

  const members = await listMembersForDoc(doc.workspaceId, doc.ownerId)
  return { members }
})
