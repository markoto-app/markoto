import { and, isNull, lt } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { documents } from '../db/schema'
import { deleteDocument } from '../utils/documentLifecycle'
import { migrationsComplete } from '../utils/migrations'
import { getDoc } from '../repos/documents'
import { appendAuditEvent } from '../repos/audit'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Periodic cleanup of abandoned documents.
//
// Policy (see shared/utils/inactiveDocPolicy.ts for the decision fn):
//   - Workspace-attached docs → never reaped.
//   - Owner-owned docs → never reaped, regardless of inactivity. An
//     authenticated account implies the user expects their docs to stay
//     around until they explicitly delete them.
//   - Anonymous docs (ownerId NULL, workspaceId NULL) → reaped after
//     `inactiveDocTtlDays` of inactivity. Default 180 days (~6 months).
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
const DAY_MS = 24 * 60 * 60 * 1000
const THROTTLE_MS = 100

export default defineNitroPlugin((nitroApp) => {
  let running = false

  async function sweep() {
    if (running) return
    running = true
    // Cross-instance gate: only one app instance runs the sweep per tick.
    if (!await acquireSweepLock('inactive-doc-sweep')) {
      running = false
      return
    }
    try {
      await migrationsComplete

      const config = useRuntimeConfig()
      const anonTtlDays = Number(config.inactiveDocTtlDays ?? 0)
      if (anonTtlDays <= 0) return

      const db = useDatabase()
      const now = Date.now()
      const anonCutoff = new Date(now - anonTtlDays * DAY_MS)

      // Candidate query mirrors shouldReapDoc(): anonymous (no owner),
      // not in a workspace, and last_active before the cutoff. Index hit
      // via idx_documents_last_active.
      const candidates = await db
        .select({ docId: documents.docId })
        .from(documents)
        .where(and(
          isNull(documents.ownerId),
          isNull(documents.workspaceId),
          lt(documents.lastActive, anonCutoff)
        ))

      if (candidates.length === 0) return

      console.log(`[inactive-doc-sweep] Reaping ${candidates.length} inactive anonymous doc(s)`)

      let reaped = 0
      for (const { docId } of candidates) {
        try {
          // Snapshot for audit forensics — system-actor row, no IP.
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
          reaped++
        } catch (e) {
          console.warn(`[inactive-doc-sweep] Failed to delete ${docId}:`, e instanceof Error ? e.message : e)
          Sentry.captureException(e, {
            tags: { component: 'inactive-doc-sweep', event: 'delete_failed', docId }
          })
        }
        // Throttle between deletions. 10/s cap keeps the S3 + pg load
        // sane if a backlog has accumulated (e.g. first post-deploy sweep).
        await new Promise(r => setTimeout(r, THROTTLE_MS))
      }

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
