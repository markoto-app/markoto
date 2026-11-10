import type { H3Event } from 'h3'
import { getDocAuthz } from './workspaceAccess'
import { getDoc } from '../repos/documents'
import { planHasFeature, resolveDocPlanFor } from './entitlements'

// Share-link controls (WP9): who may see and change them — the document's
// owner and workspace admins (`canManage`, like the access mode).

/** Longest an expiry may lie in the future. */
export const SHARE_EXPIRY_MAX_DAYS = 366

export async function requireShareManager(event: H3Event) {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) throw createError({ statusCode: 404, message: 'Document not found' })
  if (!authz.canManage) throw createError({ statusCode: 403, message: 'Only the owner and workspace admins can change how this document is shared.', data: { code: 'share/not-allowed' } })
  const doc = (await getDoc(docId))!
  const available = planHasFeature(await resolveDocPlanFor({ ownerId: doc.ownerId, workspaceId: doc.workspaceId }), 'shareControls')
  return { userId: session.user.id, docId, doc, available }
}
