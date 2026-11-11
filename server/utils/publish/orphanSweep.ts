import type { ObjectStore } from '../objectStore'

// Layer of `orphan-cleanup` (WP13): objects under `published/<pageId>/`
// whose page no longer exists — the document was deleted (the row goes
// with it by FK cascade, the objects don't) or an unpublish's own clean-up
// failed. One hour of grace: a first publish copies the files before it
// inserts the row.

const PUBLISHED_ORPHAN_GRACE_MS = 60 * 60 * 1000

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
      return m !== null && !live.has(m[1]!)
    })
    .filter(obj => (obj.lastModified ? obj.lastModified.getTime() : now) < cutoff)
    .map(obj => obj.key)
  await deps.store.deleteMany(stale)
  return { deleted: stale.length }
}
