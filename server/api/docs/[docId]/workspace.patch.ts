import { getDoc, moveDocToWorkspace } from '../../../repos/documents'
import { proveWorkspaceAccess } from '../../../utils/access/workspaceAccess'
import type { WorkspaceAccess } from '../../../repos/proofs'
import { assertNotModerationRestricted } from '../../../utils/privacy/moderationRestriction'
import { deleteSharesForDoc } from '../../../repos/documentShares'
import { deleteTemplatesForDoc } from '../../../repos/workspaceTemplates'
import { appendAuditEvent } from '../../../repos/audit'
import { notifySyncKickUser, notifySyncReauthDocument } from '../../../utils/documents/syncNotify'
import { moveDocWorkspaceBody } from '~~/shared/api/sharing'

// Move a document into, between, or out of a workspace.
//
// Body: { workspaceId: string | null }
//   - string: move into that workspace (user must be admin or editor there)
//   - null:   detach from any workspace (back to "personal")
//
// Authz:
//   - `manage` on the source (owner or current workspace admin). Editors
//     of the current workspace intentionally can't move a doc — that's a
//     sharing change, not a content edit.
//   - When targeting a workspace, actor must be admin OR editor of it
//     (creation-grade grant). Viewers can't pull docs into their own
//     view-only workspaces.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/move-not-allowed' }),
  body: moveDocWorkspaceBody,
  handler: async ({ event, user, docId, doc, docAccess, body: { workspaceId: target } }) => {
    let targetAccess: WorkspaceAccess<'editor'> | null = null
    if (target !== null) {
      // Another workspace's members would gain access.
      assertNotModerationRestricted(await getDoc(docAccess))
      const member = await proveWorkspaceAccess(user.id, target, 'member')
      if (member === null) throw apiError('auth/forbidden')
      if (!member.allows('editor')) throw apiError('share/move-target-viewer')
      targetAccess = member
    }

    // No-op if nothing would change — saves a write and keeps lastActive
    // stable when the client posts a redundant patch.
    if (doc.workspaceId === target) {
      return { success: true, workspaceId: target }
    }

    await moveDocToWorkspace(docAccess, targetAccess)
    // Guest shares belong to the workspace the document left. The
    // guests' open editor connections are closed, as on unshare — their
    // token no longer authorises the document.
    const unsharedGuestIds = await deleteSharesForDoc(docAccess)
    for (const guestId of unsharedGuestIds) notifySyncKickUser(guestId, [docId])
    // The members of the workspace it left lose access; everyone connected
    // re-authenticates against the new placement.
    notifySyncReauthDocument(docId)
    // A workspace template is a link to a document IN the
    // workspace: it goes when the document leaves.
    const templatesRemoved = await deleteTemplatesForDoc(docAccess)

    await appendAuditEvent({
      by: docAccess,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      action: 'doc.workspace_moved',
      // Shown in the workspace the document LEFT (the move out is that
      // workspace's event; `after` names the new place).
      workspaceId: doc.workspaceId,
      before: { workspaceId: doc.workspaceId },
      after: { workspaceId: target },
      ...(unsharedGuestIds.length > 0 || templatesRemoved > 0
        ? { metadata: { ...(unsharedGuestIds.length > 0 ? { guestSharesRemoved: unsharedGuestIds.length } : {}), ...(templatesRemoved > 0 ? { templatesRemoved } : {}) } }
        : {})
    })

    return { success: true, workspaceId: target }
  }
})
