import { getMembershipRole, listMembers } from '../../repos/workspaceMembers'
import { apiError } from '../api/apiError'

// Sharing a workspace document with a GUEST. Who may share (declared by
// the routes as `allow.doc('share-guests')`): admins and editors of the
// document's workspace (normal role check — SSO enforcement applies). A
// guest, even one with edit access to the document, can't share it
// further. Personal documents have no guests.

/** The guest the body names, or 400/404. */
export async function requireWorkspaceGuest(workspaceId: string, rawUserId: unknown): Promise<number> {
  const userId = Number(rawUserId)
  if (!Number.isInteger(userId) || userId <= 0) throw apiError('share/invalid', { field: 'userId' })
  if ((await getMembershipRole(workspaceId, userId)) !== 'guest') throw apiError('share/not-a-guest')
  return userId
}

export async function listWorkspaceGuests(workspaceId: string): Promise<Array<{ userId: number, name: string, email: string | null }>> {
  return (await listMembers(workspaceId)).filter(m => m.role === 'guest').map(m => ({ userId: m.userId, name: m.name, email: m.email }))
}
