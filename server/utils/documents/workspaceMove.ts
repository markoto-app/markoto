import { moveDocToWorkspace, getDoc } from '../../repos/documents'
import type { DocAccess, WorkspaceAccess } from '../../repos/proofs'
import { deleteSharesForDoc } from '../../repos/documentShares'
import { deleteTemplatesForDoc } from '../../repos/workspaceTemplates'
import { appendAuditEvent } from '../../repos/audit'
import { assertNotModerationRestricted } from '../privacy/moderationRestriction'
import { notifySyncKickUser, notifySyncReauthDocument } from './syncNotify'
import type { SecondObjectProver } from '../api/policyProver'
import { apiError } from '../api/apiError'

// Moving a document into, between or out of workspaces: the one place that
// does it, for the single-document route and the bulk action.
//
//   - `manage` on the document (owner or current workspace admin);
//   - a target workspace needs the caller's admin or editor role there, and
//     a moderation-restricted document may not be moved into one (its
//     members would gain access);
//   - guest shares and workspace templates belong to the workspace the
//     document leaves; its folder too (cleared by the repo).

export async function moveDocumentToWorkspace(
  doc: DocAccess<'manage'>,
  currentWorkspaceId: string | null,
  target: string | null,
  ctx: { prove: SecondObjectProver, actorIp: string | null }
): Promise<{ moved: boolean }> {
  let targetAccess: WorkspaceAccess<'editor'> | null = null
  if (target !== null) {
    assertNotModerationRestricted(await getDoc(doc))
    const member = await ctx.prove.workspace(target, 'member')
    if (member === null) throw apiError('auth/forbidden')
    if (!member.allows('editor')) throw apiError('share/move-target-viewer')
    targetAccess = member
  }
  if (currentWorkspaceId === target) return { moved: false }

  await moveDocToWorkspace(doc, targetAccess)
  const unsharedGuestIds = await deleteSharesForDoc(doc)
  for (const guestId of unsharedGuestIds) notifySyncKickUser(guestId, [doc.docId])
  notifySyncReauthDocument(doc.docId)
  const templatesRemoved = await deleteTemplatesForDoc(doc)

  await appendAuditEvent({
    by: doc,
    actorIp: ctx.actorIp,
    scope: 'doc',
    scopeId: doc.docId,
    action: 'doc.workspace_moved',
    // Shown in the workspace the document LEFT (`after` names the new place).
    workspaceId: currentWorkspaceId,
    before: { workspaceId: currentWorkspaceId },
    after: { workspaceId: target },
    ...(unsharedGuestIds.length > 0 || templatesRemoved > 0
      ? { metadata: { ...(unsharedGuestIds.length > 0 ? { guestSharesRemoved: unsharedGuestIds.length } : {}), ...(templatesRemoved > 0 ? { templatesRemoved } : {}) } }
      : {})
  })
  return { moved: true }
}
