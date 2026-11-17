// A short in-process cache for the admin's product stats: several admins
// (or one switching tabs) reuse a result for a minute instead of running
// the aggregates again. Per process; with several app instances each
// keeps its own, which is fine for numbers that are a minute old anyway.

export const STATS_CACHE_TTL_MS = 60_000

/** Keys are tab + range + bucket, a few dozen at most; the cap only guards against a bug. */
const MAX_ENTRIES = 200

const entries = new Map<string, { at: number, value: Promise<unknown> }>()

/**
 * The cached result for `key`, or a fresh `build()`. The promise is cached,
 * so concurrent requests share one build; a failed build is dropped at once.
 */
export function cachedAdminStats<T>(key: string, build: () => Promise<T>, now: number = Date.now()): Promise<T> {
  const hit = entries.get(key)
  if (hit && now - hit.at < STATS_CACHE_TTL_MS) return hit.value as Promise<T>
  if (entries.size >= MAX_ENTRIES) entries.clear()
  const value = build()
  entries.set(key, { at: now, value })
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key)
  })
  return value
}

export function clearAdminStatsCache(): void {
  entries.clear()
}
