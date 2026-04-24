import { eq } from 'drizzle-orm'
import { documents } from '../db/schema'

/**
 * Require that the user can edit the document. Throws 404 if the doc doesn't
 * exist, 403 if access is denied. Used by AI endpoints which mint their own
 * server-side JWT and therefore bypass the token endpoint's gating — without
 * this check, any logged-in user could run AI tools against any doc by id.
 *
 * Ownership ladder: doc owner → workspace admin/editor (via canEditDoc) →
 * accessMode=open-edit. Viewers and non-members are refused; standalone and
 * anonymous docs fall through to the accessMode check.
 */
export async function requireDocEditAccess(docId: string, userId: number): Promise<void> {
  const db = useDatabase()
  const doc = (await db
    .select({ accessMode: documents.accessMode, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // canEditDoc handles doc owner + workspace admin/editor branches. It
  // re-queries the doc internally — cheap enough for AI endpoints where
  // a few hundred ms of latency is immaterial.
  if (await canEditDoc(userId, docId)) return
  if (doc.accessMode === 'open-edit') return

  throw createError({ statusCode: 403, message: 'No write access to this document' })
}
