import { getDocWithActorRole } from '../../repos/documents'
import { canDownload, docStateOf } from '~~/shared/utils/documents/docPermissions'

// Share-link controls: who may see and change them — the document's
// owner and workspace admins (`canManage`, like the access mode).

/** Longest an expiry may lie in the future. */
export const SHARE_EXPIRY_MAX_DAYS = 366

/**
 * View only: may `userId` take this document's content away — a
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
