import { getDocWithActorRole } from '../../repos/access/docAuthz'
import { mintDocAccess, userActor } from '../../repos/proofs/mint'
import type { DocAccess, DocGrant } from '../../repos/proofs'
import { canWriteDocContent, grantedDocLevels } from './docProof'
import { docStateOf } from '../../../shared/utils/documents/docPermissions'

/**
 * Require that the user can edit the document. Throws 404 if the doc doesn't
 * exist, 403 if access is denied. Used by AI endpoints which mint their own
 * server-side JWT and therefore bypass the token endpoint's gating — without
 * this check, any logged-in user could run AI tools against any doc by id.
 * See `canWriteDocContent` for the rule.
 */
export async function requireDocEditAccess(docId: string, userId: number): Promise<DocAccess<DocGrant<'write'>>> {
  const row = await getDocWithActorRole(docId, userId)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!canWriteDocContent(row, userId)) {
    throw createError({ statusCode: 403, message: 'No write access to this document' })
  }
  const actor = { userId, workspaceRole: row.workspaceRole, isGuest: row.isGuest, hasValidDocJwt: false, isAnonCreator: false }
  return mintDocAccess(userActor(userId), docId, grantedDocLevels(row, docStateOf(row), actor), 'write')
}
