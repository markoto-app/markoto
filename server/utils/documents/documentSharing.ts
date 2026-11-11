import type { H3Event } from 'h3'
import { getDoc } from '../../repos/documents'
import { getMembershipRole, listMembers } from '../../repos/workspaceMembers'

// Sharing a workspace document with a GUEST (WP11). Who may share:
// admins and editors of the document's workspace (normal role check —
// SSO enforcement applies). A guest, even one with edit access to the
// document, can't share it further. Personal documents have no guests.

export async function requireDocSharingAccess(event: H3Event): Promise<{ userId: number, docId: string, workspaceId: string }> {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const doc = await getDoc(docId)
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })
  const role = doc.workspaceId ? await getWorkspaceRole(session.user.id, doc.workspaceId) : null
  if (!doc.workspaceId || (role !== 'admin' && role !== 'editor')) {
    throw createError({ statusCode: 403, message: 'Only admins and editors of the workspace can share this document with guests.', data: { code: 'share/not-allowed' } })
  }
  return { userId: session.user.id, docId, workspaceId: doc.workspaceId }
}

/** The guest the body names, or 400/404. */
export async function requireWorkspaceGuest(workspaceId: string, rawUserId: unknown): Promise<number> {
  const userId = Number(rawUserId)
  if (!Number.isInteger(userId) || userId <= 0) throw createError({ statusCode: 400, message: 'Invalid user.', data: { code: 'share/invalid' } })
  if ((await getMembershipRole(workspaceId, userId)) !== 'guest') {
    throw createError({ statusCode: 404, message: 'This person is not a guest of the workspace.', data: { code: 'share/not-a-guest' } })
  }
  return userId
}

export async function listWorkspaceGuests(workspaceId: string): Promise<Array<{ userId: number, name: string, email: string | null }>> {
  return (await listMembers(workspaceId)).filter(m => m.role === 'guest').map(m => ({ userId: m.userId, name: m.name, email: m.email }))
}
