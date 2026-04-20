import { and, isNull, isNotNull, lt, or, sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { documents } from '../db/schema'
import { deleteDocument } from '../utils/documentLifecycle'
import { migrationsComplete } from '../utils/migrations'

// Periodic cleanup of abandoned documents.
//
// Policy:
//   - Anonymous docs (owner_id IS NULL): reap after `inactiveDocTtlDays`.
//   - Owner-owned docs: reap after `inactiveDocOwnedTtlDays` (longer
//     grace — owners are the ones who'd notice and complain).
//   - Workspace-attached docs (present in `workspace_documents`): never
//     auto-reap. They're explicitly organised, so inactivity ≠ abandonment.
//
// `last_active` is bumped by:
//   - `meta.put` (title / word-count updates)
//   - the internal activity logger on `action: edit`, which fires per
//     sync-debounce window (~2–10s of typing)
//
// Set either TTL to 0 to disable its branch.
//
// Throttled at ~10 deletes/sec to avoid melting S3 + pg during a
// concurrent backup dump.

const STARTUP_DELAY_MS = 30_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const THROTTLE_MS = 100

export default defineNitroPlugin((nitroApp) => {
  let running = false

  async function sweep() {
    if (running) return
    running = true
    try {
      await migrationsComplete

      const config = useRuntimeConfig()
      const anonTtlDays = Number(config.inactiveDocTtlDays ?? 0)
      const ownedTtlDays = Number(config.inactiveDocOwnedTtlDays ?? 0)
      if (anonTtlDays <= 0 && ownedTtlDays <= 0) return

      const db = useDatabase()
      const now = Date.now()

      // Candidate query: docs past their respective TTL that aren't
      // attached to any workspace. Index hit via idx_documents_last_active.
      const anonCutoff = new Date(now - anonTtlDays * DAY_MS)
      const ownedCutoff = new Date(now - ownedTtlDays * DAY_MS)

      const branches = [
        anonTtlDays > 0
          ? and(isNull(documents.ownerId), lt(documents.lastActive, anonCutoff))
          : sql`false`,
        ownedTtlDays > 0
          ? and(isNotNull(documents.ownerId), lt(documents.lastActive, ownedCutoff))
          : sql`false`
      ]

      // Workspace-attached docs are pinned: inactivity ≠ abandonment when the
      // user explicitly organised them. Checked directly against the FK column
      // on `documents` (migration 0002 replaced the old join table).
      const candidates = await db
        .select({ docId: documents.docId, ownerId: documents.ownerId })
        .from(documents)
        .where(and(
          or(...branches),
          isNull(documents.workspaceId)
        ))

      if (candidates.length === 0) return

      console.log(`[inactive-doc-sweep] Reaping ${candidates.length} inactive doc(s)`)

      let reaped = 0
      for (const { docId } of candidates) {
        try {
          await deleteDocument(docId)
          reaped++
        } catch (e) {
          console.warn(`[inactive-doc-sweep] Failed to delete ${docId}:`, e instanceof Error ? e.message : e)
          Sentry.captureException(e, {
            tags: { component: 'inactive-doc-sweep', event: 'delete_failed', docId }
          })
        }
        // Throttle between deletions. 10/s cap keeps the S3 + pg load sane
        // if a backlog has accumulated (e.g. first post-deploy sweep).
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
