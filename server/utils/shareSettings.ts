import type { H3Event } from 'h3'
import { getDocAuthz } from './workspaceAccess'
import { getDoc, getDocWithActorRole } from '../repos/documents'
import { canDownload, docStateOf } from '~~/shared/utils/docPermissions'
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

/**
 * View only (WP9): may `userId` take this document's content away — a
 * PDF, page images, a Markdown export or a copy? False only for a visitor
 * (not the owner, no member role; guests count) of a view-only doc.
 * Unknown documents answer true: the caller's own access check decides.
 */
export async function userMayDownload(docId: string, userId: number | null): Promise<boolean> {
  const row = await getDocWithActorRole(docId, userId)
  if (!row) return true
  return canDownload(docStateOf(row), { userId, workspaceRole: row.workspaceRole, isGuest: row.isGuest }, row.shareNoDownload)
}

export const DOWNLOAD_DISABLED_MESSAGE = 'The owner turned off downloading this document — it can be read but not exported or copied.'
