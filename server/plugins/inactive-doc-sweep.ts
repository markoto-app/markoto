import * as Sentry from '@sentry/nuxt'
import { deleteDocument } from '../utils/documents/documentLifecycle'
import { getDoc } from '../repos/documents'
import { system } from '../repos/proofs'
import { appendAuditEvent } from '../repos/audit'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { loadInactiveAnonymousDocs, parseInactiveDocTtlDays } from '../utils/documents/inactiveDocSweep'
import { SWEEPS } from '../config/sweeps'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('inactive-doc-sweep')

// Periodic cleanup of abandoned documents.
//
// Policy (see shared/utils/documents/inactiveDocPolicy.ts for the decision fn):
//   - Workspace-attached docs → never reaped.
//   - Owner-owned docs → never reaped, regardless of inactivity. An
//     authenticated account implies the user expects their docs to stay
//     around until they explicitly delete them.
//   - Anonymous docs (ownerId NULL, workspaceId NULL) → reaped after
//     `inactiveDocTtlDays` of inactivity (NUXT_INACTIVE_DOC_TTL_DAYS,
//     default 30 — the period the Terms + privacy policy state).
//     Candidate query: server/utils/documents/inactiveDocSweep.ts.
//
// `last_active` is bumped by:
//   - `meta.put` (title / word-count updates)
//   - the internal activity logger on `action: edit`, fired per
//     sync-debounce window (~2–10s of typing).
//
// Set the TTL to 0 to disable sweeping entirely.
//
// Throttled at ~10 deletes/sec so a backlog-clearing sweep doesn't melt
// S3 and Postgres while the backup sidecar is running.

const THROTTLE_MS = 100

async function sweep(): Promise<{ candidates: number, reaped: number } | undefined> {
  const anonTtlDays = parseInactiveDocTtlDays(useEnv().legal.inactiveDocTtlDays)
  if (anonTtlDays <= 0) return
  const candidates = await loadInactiveAnonymousDocs(anonTtlDays)
  if (candidates.length === 0) return
  log.info('reaping inactive anonymous docs', { candidates: candidates.length })
  return { candidates: candidates.length, reaped: await reapDocs(candidates) }
}

/**
 * Throttled delete loop. 10/s cap keeps S3 + Postgres load sane if a
 * backlog has accumulated (e.g. first post-deploy sweep). One bad
 * doc never aborts the rest.
 */
async function reapDocs(candidates: Array<{ docId: string }>): Promise<number> {
  let reaped = 0
  for (const { docId } of candidates) {
    if (await reapOneDoc(docId)) reaped++
    await new Promise(r => setTimeout(r, THROTTLE_MS))
  }
  return reaped
}

/** Snapshot → delete → audit. Returns false if anything threw (Sentry already captured). */
async function reapOneDoc(docId: string): Promise<boolean> {
  try {
    const sweep = system('inactive-doc-sweep')
    const doc = sweep.doc(docId)
    const snapshot = await getDoc(doc)
    await deleteDocument(doc)
    await appendAuditEvent({
      by: sweep,
      actorIp: null,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.deleted',
      before: snapshot
        ? {
            title: snapshot.title,
            accessMode: snapshot.accessMode,
            ownerId: snapshot.ownerId,
            workspaceId: snapshot.workspaceId
          }
        : null,
      after: null,
      metadata: { reason: 'inactive_sweep' }
    })
    return true
  } catch (e) {
    log.warn('failed to delete inactive doc', { docId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'inactive-doc-sweep', event: 'delete_failed', docId }
    })
    return false
  }
}

export default defineSweeper({
  name: 'inactive-doc-sweep',
  schedule: SWEEPS.inactiveDocs,
  run: sweep
})
