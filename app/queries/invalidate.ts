import type { EntryKey, QueryCache } from '@pinia/colada'

/**
 * Marks every query under each key stale and refetches the ones on screen,
 * resolving once they have settled. A failed refetch is not the caller's
 * failure (the mutation before it succeeded): it lands in that query's own
 * error state, so it is swallowed here.
 */
export async function invalidate(cache: QueryCache, ...keys: EntryKey[]): Promise<void> {
  await Promise.all(keys.map(key => cache.invalidateQueries({ key }).catch(() => {})))
}
