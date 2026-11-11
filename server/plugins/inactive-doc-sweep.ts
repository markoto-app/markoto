import * as Sentry from '@sentry/nuxt'
import { deleteDocument } from '../utils/documents/documentLifecycle'
import { migrationsComplete } from '../utils/platform/migrations'
import { getDoc } from '../repos/documents'
import { appendAuditEvent } from '../repos/audit'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { loadInactiveAnonymousDocs, parseInactiveDocTtlDays } from '../utils/documents/inactiveDocSweep'

// Periodic cleanup of abandoned documents.
//
// Policy (see shared/utils/documents/inactiveDocPolicy.ts for the decision fn):
//   - Workspace-attached docs → never reaped.
//   - Owner-owned docs → never reaped, regardless of inactivity. An
//     authenticated account implies the user expects their docs to stay
//     around until they explicitly delete them.
//   - Anonymous docs (ownerId NULL, workspaceId NULL) → reaped after
//     `inactiveDocTtlDays` of inactivity (NUXT_INACTIVE_DOC_TTL_DAYS,
//     default 30 — the period the Terms + privacy policy state) once
//     their `sweep_not_before` floor has passed. Candidate
//     query: server/utils/documents/inactiveDocSweep.ts.
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

const STARTUP_DELAY_MS = 30_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const THROTTLE_MS = 100

let running = false

async function sweep(): Promise<void> {
  if (running) return
  running = true
  // Cross-instance gate: only one app instance runs the sweep per tick.
  if (!await acquireSweepLock('inactive-doc-sweep')) {
    running = false
    return
  }
  try {
    await migrationsComplete
    const anonTtlDays = parseInactiveDocTtlDays(useRuntimeConfig().inactiveDocTtlDays)
    if (anonTtlDays <= 0) return
    const candidates = await loadInactiveAnonymousDocs(anonTtlDays)
    if (candidates.length === 0) return
    console.log(`[inactive-doc-sweep] Reaping ${candidates.length} inactive anonymous doc(s)`)
    const reaped = await reapDocs(candidates)
    if (reaped > 0) {
      console.log(`[inactive-doc-sweep] Reaped ${reaped}/${candidates.length} inactive doc(s)`)
    }
  } catch (e) {
    console.error('[inactive-doc-sweep] Sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'inactive-doc-sweep', event: 'sweep_failed' }
    })
  } finally {
    await releaseSweepLock('inactive-doc-sweep')
    running = false
  }
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
    const snapshot = await getDoc(docId)
    await deleteDocument(docId)
    await appendAuditEvent({
      actorUserId: null,
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
    console.warn(`[inactive-doc-sweep] Failed to delete ${docId}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'inactive-doc-sweep', event: 'delete_failed', docId }
    })
    return false
  }
}

export default defineNitroPlugin((nitroApp) => {
  const startupTimer = setTimeout(() => {
    void sweep()
  }, STARTUP_DELAY_MS)
  const intervalTimer = setInterval(() => {
    void sweep()
  }, SWEEP_INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })
})
