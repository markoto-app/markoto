import { getDocWithActorRole } from '../../../repos/documents'
import { isEffectiveDocOwner } from '../../../../shared/utils/docPermissions'
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

  const userId = session?.user?.id ?? null
  // One query: doc + the caller's role (SSO condition included) + whether
  // their ownership counts (WP14 — not in an SSO-enforcing workspace
  // without an effective role there).
  const doc = await getDocWithActorRole(docId, userId)
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })

  // No workspace ⇒ no roster to disclose.
  if (!doc.workspaceId) return { members: [] }

  if (userId === null) return { members: [] }

  // Must be either a workspace member or the doc owner (who may have been
  // booted from a workspace without SSO but still owns the doc).
  if (doc.workspaceRole === null && !isEffectiveDocOwner(doc, userId)) return { members: [] }

  const members = await listMembersForDoc(doc.workspaceId, doc.ownerId)
  return { members }
})
