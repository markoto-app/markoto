import type { MaybeRefOrGetter, WritableComputedRef } from 'vue'

/**
 * One choice from a fixed set, kept in a query parameter so the view can be
 * linked and survives a reload (`/admin/stats?tab=revenue&range=90`).
 *
 * Reading is pure: a missing value, an unknown one, or one the viewer may not
 * see (a role-gated tab missing from `allowed`) reads as `fallback`, without
 * touching the URL. Writing uses `router.replace` (switching tabs adds no
 * history entries) and drops the parameter for `fallback`, so the default
 * view keeps a clean URL. The value comes from the route, so the server
 * render already shows the linked choice.
 */
export function useRouteQueryChoice<T extends string>(
  key: string,
  allowed: MaybeRefOrGetter<readonly T[]>,
  fallback: T
): WritableComputedRef<T> {
  const route = useRoute()
  const router = useRouter()
  return computed<T>({
    get: () => {
      const value = route.query[key]
      return typeof value === 'string' && (toValue(allowed) as readonly string[]).includes(value) ? value as T : fallback
    },
    set: (value) => {
      const { [key]: _previous, ...rest } = route.query
      const query = value === fallback ? rest : { ...rest, [key]: value }
      void router.replace({ query, hash: route.hash })
    }
  })
}

/** The page's active tab in `?tab=`: stable English kebab-case slugs. */
export function useRouteTab<T extends string>(allowed: MaybeRefOrGetter<readonly T[]>, fallback: T): WritableComputedRef<T> {
  return useRouteQueryChoice('tab', allowed, fallback)
}
