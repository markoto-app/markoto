import { listAllKnowledgeS3Keys } from '../../repos/knowledge'
import { system } from '../../repos/proofs'
import type { ObjectStore } from '../storage/objectStore'
import { HOUR_MS } from '~~/shared/config/units'

// Reaps knowledge-upload objects no `workspace_knowledge` row points at:
//   - originals that were PUT but never confirmed (upload-request creates
//     no DB row; its pending record lives in Valkey and simply expires),
//   - staging objects (`…/knowledge/staging/…`) left behind by a confirm
//     that failed half-way or by a presigned URL re-used after confirm,
//   - originals of rows that were deleted (workspace deletion cascades the
//     rows; the objects go here).
// Objects younger than the grace period are left alone so an upload that
// is still in flight (PUT done, confirm not yet committed) survives. The
// presigned URL lives 120 s and the pending record 6 min, so after an hour
// nothing can confirm such an object any more.
//
// Runs as a layer of the `orphan-cleanup` sweeper (under its sweep lock).

export const KNOWLEDGE_ORPHAN_GRACE_MS = HOUR_MS

// Exactly the shapes upload-request mints (final + staging). Anything
// else under `workspaces/` is not ours to judge and is never touched.
const KNOWLEDGE_OBJECT_RE = /^workspaces\/[A-Za-z0-9_-]+\/knowledge\/(?:staging\/)?[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/

function isKnowledgeObjectKey(key: string): boolean {
  return KNOWLEDGE_OBJECT_RE.test(key)
}

export interface KnowledgeOrphanSweepDeps {
  store: ObjectStore
  /** Injectable clock for tests. */
  now?: number
  graceMs?: number
}

export async function sweepKnowledgeOrphans(deps: KnowledgeOrphanSweepDeps): Promise<{ deleted: number }> {
  const now = deps.now ?? Date.now()
  const cutoff = now - (deps.graceMs ?? KNOWLEDGE_ORPHAN_GRACE_MS)

  const candidates = (await deps.store.list('workspaces/'))
    .filter(obj => isKnowledgeObjectKey(obj.key))
    // Missing LastModified = treat as fresh (never delete on doubt).
    .filter(obj => (obj.lastModified ? obj.lastModified.getTime() : now) < cutoff)
    .map(obj => obj.key)
  if (candidates.length === 0) return { deleted: 0 }

  // Read the rows AFTER listing: a row committed while we listed is seen.
  const known = new Set(await listAllKnowledgeS3Keys(system('orphan-cleanup')))
  const orphans = candidates.filter(k => !known.has(k))
  await deps.store.deleteMany(orphans)
  return { deleted: orphans.length }
}
