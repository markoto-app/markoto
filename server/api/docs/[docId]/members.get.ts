import { isEffectiveDocOwner } from '../../../../shared/utils/documents/docPermissions'
import { listMembersForDoc } from '../../../repos/workspaceMembers'

// Access roster for a doc. Used by the in-doc presence bar to render
// everyone who HAS access, not just who's live. Non-live members render
// at reduced opacity with a role tooltip.
//
// Visibility:
//   - Caller must be a workspace member of the doc's workspace, OR the doc
//     owner. Non-member signed-in users get an empty roster — a
//     public-link doc shouldn't reveal the team roster. This matches
//     Google Docs behavior (link-holders don't see the sharing list).
//     Anonymous callers never get here (not on the public allowlist).
//
// Standalone docs (no workspaceId) return an empty roster. The doc owner
// is already implicit and showing just themselves offline is clutter.
export default defineApiHandler({
  access: allow.doc('lookup', { reason: 'Never refuses an existing document: callers without a role in its workspace get an empty roster.' }),
  handler: async ({ user, doc }) => {
    // No workspace ⇒ no roster to disclose.
    if (!doc.workspaceId) return { members: [] }

    // `doc.workspaceRole` carries the SSO condition, and ownership doesn't
    // count in an SSO-enforcing workspace without an effective role. Must be
    // either a workspace member or the doc owner (who may have been booted
    // from a workspace without SSO but still owns the doc).
    if (doc.workspaceRole === null && !isEffectiveDocOwner(doc, user.id)) return { members: [] }

    const members = await listMembersForDoc(doc.workspaceId, doc.ownerId)
    return { members }
  }
})
