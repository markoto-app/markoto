import type { ObjectStore } from '../storage/objectStore'
import { HOUR_MS } from '~~/shared/config/units'

// Layer of `orphan-cleanup`: objects under `published/<pageId>/`
// whose page no longer exists — the document was deleted (the row goes
// with it by FK cascade, the objects don't) or an unpublish's own clean-up
// failed. One hour of grace: a first publish copies the files before it
// inserts the row.

const PUBLISHED_ORPHAN_GRACE_MS = HOUR_MS

const PUBLISHED_KEY_RE = /^published\/([A-Za-z0-9_-]{16})\/(?:files|brand)\/[^/]+$/

export async function sweepPublishedOrphans(deps: {
  store: ObjectStore
  livePageIds: () => Promise<ReadonlySet<string>>
  now?: number
  graceMs?: number
}): Promise<{ deleted: number }> {
  const now = deps.now ?? Date.now()
  const cutoff = now - (deps.graceMs ?? PUBLISHED_ORPHAN_GRACE_MS)
  const objects = await deps.store.list('published/')
  if (objects.length === 0) return { deleted: 0 }
  const live = await deps.livePageIds()
  const stale = objects
    .filter((obj) => {
      const m = PUBLISHED_KEY_RE.exec(obj.key)
      const pageId = m?.[1]
      return pageId !== undefined && !live.has(pageId)
    })
    .filter(obj => (obj.lastModified ? obj.lastModified.getTime() : now) < cutoff)
    .map(obj => obj.key)
  await deps.store.deleteMany(stale)
  return { deleted: stale.length }
}
