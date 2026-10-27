import { getDocWithActorRole, type DocAuthzRow } from '../repos/documents'
import { decideTokenAccess } from '../../shared/utils/docPermissions'

/**
 * Can this logged-in user write to the document's CONTENT through a
 * server-side path (AI prompt, @ai comment trigger, restore, dictation,
 * image upload)? Same rule as the Y.js token the editor gets from
 * `GET /api/docs/:id/token` — `decideTokenAccess` granting a writable
 * token — so no endpoint can hand out more than the editor itself:
 *
 *   - doc owner, workspace admin/editor → yes, on every access mode;
 *   - workspace viewer → no, even on `open-edit` docs (viewer wins over
 *     the public edit grant);
 *   - anyone else → only on `open-edit` docs.
 *
 * Password knowledge doesn't count here: these routes require a session,
 * and a password-protected doc's non-members get no server-side write
 * path (the password JWT only covers the Y.js connection).
 */
export function canWriteDocContent(row: DocAuthzRow, userId: number): boolean {
  const decision = decideTokenAccess(
    { ownerId: row.ownerId, workspaceId: row.workspaceId, accessMode: row.accessMode },
    { userId, workspaceRole: row.workspaceRole }
  )
  return decision.outcome === 'allow' && !decision.readOnly
}

/**
 * Require that the user can edit the document. Throws 404 if the doc doesn't
 * exist, 403 if access is denied. Used by AI endpoints which mint their own
 * server-side JWT and therefore bypass the token endpoint's gating — without
 * this check, any logged-in user could run AI tools against any doc by id.
 * See `canWriteDocContent` for the rule.
 */
export async function requireDocEditAccess(docId: string, userId: number): Promise<void> {
  const row = await getDocWithActorRole(docId, userId)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!canWriteDocContent(row, userId)) {
    throw createError({ statusCode: 403, message: 'No write access to this document' })
  }
}
