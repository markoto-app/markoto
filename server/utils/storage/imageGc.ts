import * as Sentry from '@sentry/nuxt'
import * as Y from 'yjs'
import {
  deleteExpiredUnreferencedUpload,
  listGcCandidateDocIds,
  listGcCandidatesForDoc,
  recordGcCheck,
  type GcCandidate
} from '../../repos/uploads'
import { useDatabasePool } from '../platform/database'
import type { ObjectStore } from './objectStore'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'

// Garbage collection of document images nobody can see or restore any more.
//
// SAFETY RULE: an image is deleted only when ALL of these hold.
//   1. It was confirmed more than CONFIRM_GRACE_MS ago (an image that was
//      just uploaded may not have been inserted into the text yet).
//   2. Its fileId appears in NONE of these, checked at every GC run:
//      a. any state of its own document that can still be reconstructed —
//         the stored Y.js update log is replayed row by row and the text,
//         the meta map (title / theme incl. theme images and custom CSS)
//         and the comments array are searched after EVERY row. Activity-log
//         restore points are row boundaries of that same log, so every
//         restorable version is covered; versions merged away by
//         compaction are not restorable any more;
//      b. any other place a reference to `/api/files/{docId}/{fileId}` can
//         live: the raw bytes of every stored Y.js update (any doc — a URL
//         pasted into another doc, or not-yet-compacted history), every
//         document theme, workspace default theme, saved theme preset,
//         comment body, and activity-log metadata (comment snapshots);
//   3. 2. has held at every check for at least the retention window
//      (`NUXT_IMAGE_GC_RETENTION_DAYS`, default 30): the first unreferenced
//      check stamps `unreferenced_since`, any later check that finds a
//      reference clears it, and the delete itself is conditional on the
//      stamp still being older than the window.
// When in doubt the image stays: a doc without any stored Y.js rows is
// skipped, a missing `yjs_documents` table disables the run, and every
// error leaves rows untouched.
//
// Runs from `server/plugins/image-gc-sweep.ts` under its sweep lock.

export const IMAGE_GC_DEFAULT_RETENTION_DAYS = 30
/** Freshly confirmed images are not looked at for a day. */
const IMAGE_GC_CONFIRM_GRACE_MS = DAY_MS
/** Each doc is checked at most about once a day. */
const IMAGE_GC_RECHECK_MS = 20 * HOUR_MS
const IMAGE_GC_MAX_DOCS_PER_RUN = 50

/**
 * `NUXT_IMAGE_GC_RETENTION_DAYS`: days an image must stay unreferenced
 * before it is deleted. `0` disables the GC. Absent / invalid → default.
 */
export function resolveImageGcRetentionDays(source?: RawEnv): number {
  return useEnv(source).storage.imageGcRetentionDays
}

/**
 * Replay `updates` (in stored order) and return the fileIds that occur in
 * the document after ANY prefix of them — i.e. in any version that can be
 * reconstructed from the stored rows. Pure; exported for unit tests.
 */
export function findFileIdsInHistory(updates: Uint8Array[], fileIds: string[]): Set<string> {
  const found = new Set<string>()
  const remaining = new Set(fileIds)
  if (remaining.size === 0) return found
  const doc = new Y.Doc()
  try {
    const text = doc.getText('content')
    const meta = doc.getMap('meta')
    const comments = doc.getArray('comments')
    for (const update of updates) {
      Y.applyUpdate(doc, update)
      const haystack = `${text.toString()}\n${JSON.stringify(meta.toJSON())}\n${JSON.stringify(comments.toJSON())}`
      for (const id of remaining) {
        if (haystack.includes(id)) {
          found.add(id)
          remaining.delete(id)
        }
      }
      if (remaining.size === 0) break
    }
  } finally {
    doc.destroy()
  }
  return found
}

async function yjsTableExists(): Promise<boolean> {
  const res = await useDatabasePool().query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'yjs_documents' AND relkind = 'r') AS exists`
  )
  return res.rows[0]?.exists === true
}

async function loadDocUpdates(docId: string): Promise<Uint8Array[]> {
  const res = await useDatabasePool().query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' ORDER BY id ASC`,
    [docId]
  )
  return res.rows.map(r => new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.byteLength))
}

/**
 * Which of `paths` (`{docId}/{fileId}`) occur anywhere outside the doc's
 * own replay: raw Y.js bytes of every doc, themes, comments, activity
 * metadata. One scan per source for all paths together.
 */
async function findExternallyReferencedPaths(paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const res = await useDatabasePool().query<{ path: string }>(
    `SELECT p.path FROM unnest($1::text[]) AS p(path)
     WHERE EXISTS (SELECT 1 FROM yjs_documents y
                   WHERE position(convert_to(p.path, 'UTF8') IN y.value) > 0)
        OR EXISTS (SELECT 1 FROM documents d WHERE strpos(d.theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM workspaces w WHERE strpos(w.default_theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM themes t WHERE strpos(t.theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM document_comments c WHERE strpos(c.body, p.path) > 0)
        OR EXISTS (SELECT 1 FROM activity_log a WHERE strpos(a.metadata::text, p.path) > 0)`,
    [paths]
  )
  return new Set(res.rows.map(r => r.path))
}

export interface ImageGcDeps {
  store: ObjectStore
  now?: Date
  retentionDays?: number
  maxDocs?: number
}

export interface ImageGcResult {
  docsChecked: number
  unreferenced: number
  deleted: number
}

/** Split one doc's candidates into referenced / unreferenced. */
async function classifyDocCandidates(docId: string, candidates: GcCandidate[]): Promise<{ referenced: GcCandidate[], unreferenced: GcCandidate[] } | null> {
  const updates = await loadDocUpdates(docId)
  // No stored state at all: nothing to prove a negative against. Skip.
  if (updates.length === 0) return null
  const inHistory = findFileIdsInHistory(updates, candidates.map(c => c.fileId))
  const rest = candidates.filter(c => !inHistory.has(c.fileId))
  const external = await findExternallyReferencedPaths(rest.map(c => `${docId}/${c.fileId}`))
  const referenced: GcCandidate[] = []
  const unreferenced: GcCandidate[] = []
  for (const c of candidates) {
    if (inHistory.has(c.fileId) || external.has(`${docId}/${c.fileId}`)) referenced.push(c)
    else unreferenced.push(c)
  }
  return { referenced, unreferenced }
}

export async function runImageGc(deps: ImageGcDeps): Promise<ImageGcResult> {
  const result: ImageGcResult = { docsChecked: 0, unreferenced: 0, deleted: 0 }
  const retentionDays = deps.retentionDays ?? resolveImageGcRetentionDays()
  if (retentionDays <= 0) return result
  if (!(await yjsTableExists())) return result

  const now = deps.now ?? new Date()
  const confirmedBefore = new Date(now.getTime() - IMAGE_GC_CONFIRM_GRACE_MS)
  const deleteCutoff = new Date(now.getTime() - retentionDays * DAY_MS)
  const docIds = await listGcCandidateDocIds({
    confirmedBefore,
    checkedBefore: new Date(now.getTime() - IMAGE_GC_RECHECK_MS),
    limit: deps.maxDocs ?? IMAGE_GC_MAX_DOCS_PER_RUN
  })

  for (const docId of docIds) {
    try {
      const candidates = await listGcCandidatesForDoc(docId, confirmedBefore)
      if (candidates.length === 0) continue
      const classified = await classifyDocCandidates(docId, candidates)
      // Skipped docs still get their check stamped (as referenced), so the
      // rotation moves on and no stale stamp survives.
      const referenced = classified ? classified.referenced : candidates
      const unreferenced = classified ? classified.unreferenced : []
      await recordGcCheck({
        referencedIds: referenced.map(c => c.id),
        unreferencedIds: unreferenced.map(c => c.id),
        now
      })
      result.docsChecked++
      result.unreferenced += unreferenced.length

      for (const c of unreferenced) {
        // Only a stamp from an EARLIER check can be old enough.
        if (!c.unreferencedSince || c.unreferencedSince >= deleteCutoff) continue
        const s3Key = await deleteExpiredUnreferencedUpload(c.id, deleteCutoff)
        if (!s3Key) continue
        result.deleted++
        // Row first, object second: a failed S3 delete leaves an untracked
        // object that orphan-cleanup's defensive layer reaps after 24 h.
        try {
          await deps.store.deleteMany([s3Key])
        } catch (e) {
          Sentry.captureException(e, { tags: { component: 'image-gc', event: 's3_delete_failed' } })
        }
      }
    } catch (e) {
      console.warn(`[image-gc] check failed for doc ${docId}:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'image-gc', event: 'doc_check_failed' } })
    }
  }
  return result
}
