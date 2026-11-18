import { onScopeDispose, shallowReactive, toValue, type MaybeRefOrGetter } from 'vue'

// Pinia Colada keeps ONE options object per cache entry: the one of the
// `useQuery` that ran last. When two readers of the same key pass different
// `enabled` values (the dashboard wants the list now, a closed dialog
// further down the page does not), the entry is enabled or not depending
// on which of them happened to mount last. `invalidateQueries` skips a
// disabled entry, so a mutation's refresh silently did nothing on the
// dashboard once the explorer's (closed) move dialog had mounted after it.
//
// `sharedEnabled` gives every reader of a key the same `enabled`: a getter
// that is true while ANY mounted reader wants the data. Each reader adds its
// own wish and removes it when its scope ends.

const wishes = new Map<string, Set<() => boolean>>()

/**
 * An `enabled` getter for a query read from several components: true while
 * any reader that registered under `id` wants it. Call it in a component or
 * effect scope (the wish is removed with the scope).
 */
export function sharedEnabled(id: string, active: MaybeRefOrGetter<boolean>): () => boolean {
  // The server never runs these queries, and its component scopes are never
  // disposed: registering there would keep every request's readers.
  if (import.meta.server) return () => false
  let set = wishes.get(id)
  if (!set) {
    set = shallowReactive(new Set<() => boolean>())
    wishes.set(id, set)
  }
  const readers = set
  const wish = () => toValue(active)
  readers.add(wish)
  onScopeDispose(() => readers.delete(wish))
  return () => {
    for (const w of readers) {
      if (w()) return true
    }
    return false
  }
}
