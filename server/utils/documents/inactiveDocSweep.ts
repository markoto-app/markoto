import { and, isNull, lt } from 'drizzle-orm'
import { documents } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { DAY_MS } from '~~/shared/config/units'

// Candidate query for the inactive-doc sweep (server/plugins/inactive-doc-sweep.ts).
//
// An anonymous document (no owner, no workspace) is deleted once it has
// had no activity for `ttlDays` (NUXT_INACTIVE_DOC_TTL_DAYS, default 30 —
// the period the Terms and the privacy policy state).
//
// Owned and workspace docs are never candidates.

/** Parse NUXT_INACTIVE_DOC_TTL_DAYS: a positive integer, else 0 (= sweep off). */
export function parseInactiveDocTtlDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : 0
}

export async function loadInactiveAnonymousDocs(
  ttlDays: number,
  now: Date = new Date()
): Promise<Array<{ docId: string }>> {
  if (ttlDays <= 0) return []
  const cutoff = new Date(now.getTime() - ttlDays * DAY_MS)
  return useDatabase()
    .select({ docId: documents.docId })
    .from(documents)
    .where(and(
      isNull(documents.ownerId),
      isNull(documents.workspaceId),
      lt(documents.lastActive, cutoff)
    ))
}
