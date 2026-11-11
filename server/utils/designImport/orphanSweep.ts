import type { ObjectStore } from '../objectStore'
import { DESIGN_IMPORT_OBJECT_RE } from './guard'

// Layer of `orphan-cleanup`: design-import leftovers. Nothing of a design
// run is meant to stay in storage — `start` deletes the uploaded file as
// soon as it has read it, and every sample render is deleted after its
// PNGs were read. What is left after an hour is debris: an upload that
// was never started (or a re-used presigned URL), a render whose
// clean-up failed. Only these exact key shapes are touched.

const DESIGN_IMPORT_ORPHAN_GRACE_MS = 60 * 60 * 1000

const SAMPLE_RENDER_RE = /^renders\/design-sample-[A-Za-z0-9]{20}\//

export function isDesignImportDebris(key: string): boolean {
  return DESIGN_IMPORT_OBJECT_RE.test(key) || SAMPLE_RENDER_RE.test(key)
}

export async function sweepDesignImportOrphans(deps: { store: ObjectStore, now?: number, graceMs?: number }): Promise<{ deleted: number }> {
  const now = deps.now ?? Date.now()
  const cutoff = now - (deps.graceMs ?? DESIGN_IMPORT_ORPHAN_GRACE_MS)
  const objects = [
    ...await deps.store.list('design-imports/'),
    ...await deps.store.list('renders/design-sample-')
  ]
  const stale = objects
    .filter(obj => isDesignImportDebris(obj.key))
    // Missing LastModified = treat as fresh (never delete on doubt).
    .filter(obj => (obj.lastModified ? obj.lastModified.getTime() : now) < cutoff)
    .map(obj => obj.key)
  await deps.store.deleteMany(stale)
  return { deleted: stale.length }
}
