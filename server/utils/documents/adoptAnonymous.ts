import type { H3Event } from 'h3'
import { adoptAnonymousDocs, type AdoptedDoc } from '../../repos/documents'
import { recordAccountAcquisitionSource } from '../../repos/acquisition'
import { useLogger } from '../platform/logger'
import type { AcquisitionSource } from '~~/shared/analytics/acquisition'
import { appendAuditEvent } from '../../repos/audit'
import type { UserScope } from '../../repos/proofs'
import { AUDIT_DOC_ADOPTED } from '../../legal/auditActions'
import { hashAnonCreatorKey, readAnonCreatorKey } from '../auth/anonCreator'
import { proveDocNeed } from '../access/docProof'
import { reindexDocument } from './searchIndex'
import { resolveAnonDocTtlDays } from '~~/shared/config/anonGate'
import { DAY_MS } from '~~/shared/config/units'
import { getClientIp } from '../platform/clientIp'

/**
 * Documents taken over per sign-in. A browser that made more (a script, a
 * shared kiosk) keeps the rest anonymous; the next sign-in takes the next
 * batch.
 */
export const ADOPT_MAX_PER_SIGN_IN = 50

const log = useLogger('adopt-anonymous')

/** The source of the earliest adopted document that has one: how the person first found us. */
export function firstAcquisitionSource(rows: readonly AdoptedDoc[]): AcquisitionSource | null {
  const withSource = rows.filter(r => r.acquisitionSource !== null)
  withSource.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return withSource[0]?.acquisitionSource ?? null
}

/**
 * "Sign in to keep your documents": after a sign-in, the anonymous
 * documents this browser created (`markoto-anon-creator` cookie, see
 * `auth/anonCreator.ts`) become the account's. Documents another browser
 * made, documents already owned or moved into a workspace, deleted ones
 * and ones past the inactivity limit (about to be swept) are left alone.
 * Idempotent. Each document is audited and indexed for search (anonymous
 * documents are never indexed). The account keeps the documents'
 * acquisition source if it has none yet.
 */
export async function adoptBrowserDocuments(event: H3Event, self: UserScope): Promise<{ adopted: number }> {
  const key = readAnonCreatorKey(event)
  if (key === null) return { adopted: 0 }
  const ttlDays = resolveAnonDocTtlDays()
  const activeSince = ttlDays > 0 ? new Date(Date.now() - ttlDays * DAY_MS) : null
  const rows = await adoptAnonymousDocs(self, hashAnonCreatorKey(key), { limit: ADOPT_MAX_PER_SIGN_IN, activeSince })
  const actorIp = getClientIp(event)
  for (const row of rows) {
    await appendAuditEvent({
      by: self,
      actorIp,
      scope: 'doc',
      scopeId: row.docId,
      action: AUDIT_DOC_ADOPTED,
      workspaceId: null,
      before: { ownerId: null },
      after: { ownerId: self.userId, accessMode: row.accessMode },
      metadata: { anonTermsVersion: row.anonTermsVersion }
    })
    const proof = await proveDocNeed(self.userId, row.docId, 'write-content')
    if (proof) await reindexDocument(proof)
  }
  // The account takes the source its anonymous documents were created
  // with, unless it already has one (write-once; admin funnel).
  const source = firstAcquisitionSource(rows)
  if (source) {
    try {
      await recordAccountAcquisitionSource(self, source)
    } catch (err) {
      log.warn('could not keep the acquisition source', { reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { adopted: rows.length }
}
