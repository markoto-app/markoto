import { getDoc, moveDocToWorkspace } from '../../../repos/documents'
import { assertNotModerationRestricted } from '../../../utils/moderationRestriction'
import { deleteSharesForDoc } from '../../../repos/documentShares'
import { deleteTemplatesForDoc } from '../../../repos/workspaceTemplates'
import { appendAuditEvent } from '../../../repos/audit'
import { notifySyncKickUser } from '../../../utils/syncNotify'

// Move a document into, between, or out of a workspace.
//
// Body: { workspaceId: string | null }
//   - string: move into that workspace (user must be admin or editor there)
//   - null:   detach from any workspace (back to "personal")
//
// Authz:
//   - Actor must pass canManageDoc on the source (owner or current
//     workspace admin). Editors of the current workspace intentionally
//     can't move a doc — that's a sharing change, not a content edit.
//   - When targeting a workspace, actor must be admin OR editor of it
//     (creation-grade grant). Viewers can't pull docs into their own
//     view-only workspaces.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  // `readBody` returns undefined (not throws) for an empty body — coerce
  // to `{}` so the `in` check below doesn't explode on a missing body.
  const body = ((await readBody(event).catch(() => null)) ?? {}) as {
    workspaceId?: unknown
  }

  if (!('workspaceId' in body)) {
    throw createError({ statusCode: 400, message: 'workspaceId is required (string or null)' })
  }
  const rawTarget = body.workspaceId
  if (rawTarget !== null && (typeof rawTarget !== 'string' || rawTarget.length === 0)) {
    throw createError({ statusCode: 400, message: 'workspaceId must be a non-empty string or null' })
  }
  // After the guard: rawTarget is `string | null`. `workspaceId: undefined`
  // — which hits the `in` check if someone serialized it explicitly —
  // fails the typeof string branch and is rejected as 400.
  const target: string | null = rawTarget

  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canManage) {
    throw createError({ statusCode: 403, message: 'Only the owner or a workspace admin can move this document' })
  }

  if (target !== null) {
    // Another workspace's members would gain access.
    assertNotModerationRestricted(await getDoc(docId))
    const targetRole = await getWorkspaceRole(session.user.id, target)
    if (targetRole === null) {
      throw createError({ statusCode: 403, message: 'Not a member of the target workspace' })
    }
    if (targetRole === 'viewer') {
      throw createError({ statusCode: 403, message: 'Viewers cannot receive documents into a workspace' })
    }
  }

  // No-op if nothing would change — saves a write and keeps lastActive
  // stable when the client posts a redundant patch.
  if (authz.workspaceId === target) {
    return { success: true, workspaceId: target }
  }

  await moveDocToWorkspace(docId, target)
  // Guest shares belong to the workspace the document left (WP11). The
  // guests' open editor connections are closed, as on unshare — their
  // token no longer authorises the document.
  const unsharedGuestIds = await deleteSharesForDoc(docId)
  for (const guestId of unsharedGuestIds) notifySyncKickUser(guestId, [docId])
  // A workspace template (WP10c) is a link to a document IN the
  // workspace: it goes when the document leaves.
  const templatesRemoved = await deleteTemplatesForDoc(docId)

  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: ip,
    scope: 'doc',
    scopeId: docId,
    action: 'doc.workspace_moved',
    // Shown in the workspace the document LEFT (the move out is that
    // workspace's event; `after` names the new place).
    workspaceId: authz.workspaceId,
    before: { workspaceId: authz.workspaceId },
    after: { workspaceId: target },
    ...(unsharedGuestIds.length > 0 || templatesRemoved > 0
      ? { metadata: { ...(unsharedGuestIds.length > 0 ? { guestSharesRemoved: unsharedGuestIds.length } : {}), ...(templatesRemoved > 0 ? { templatesRemoved } : {}) } }
      : {})
  })

  return { success: true, workspaceId: target }
})
