# Client data: queries, local state and Y.js

The app holds three kinds of data, and each has one home.

| Kind | Examples | Where it lives |
|---|---|---|
| **Server state**: a server answer more than one view reads, or one a mutation elsewhere changes | the plan and limits, account status, AI points and availability, saved themes, the workspace list, plan prices | a **query** in `app/queries/<domain>.ts` (Pinia Colada) |
| **The document** | text, title and theme (`ymeta`), comments anchors, awareness / presence | **Y.js** over Hocuspocus (`app/composables/document/`). Never cache it in a query: Y.js already keeps it live |
| **Everything else** | form drafts, open dialogs, the selected tab, editor UI state, the AI session stream, dictation, the live preview | **local** `ref` / `computed` in the component or composable |

Calls whose result is not kept also stay as plain `apiFetch` in the component: checkout and portal redirects, presigned uploads, import, PDF download, duplicate, restore, token minting, the AI prompt, and reads only one view shows and reloads on every visit (a workspace's audit log, its usage tab). Content pages rendered on the server keep `useAsyncData` (`docs:*`, `marketing:*`, legal pages).

Rule of thumb: if a second component needs the same answer, or a mutation in one view should update another, make it a query.

## Reading: add a query

Each domain file has a **key factory**, the **query options**, and usually a small composable that adds `enabled`:

```ts
// app/queries/themes.ts
export const themeKeys = {
  root: ['themes'] as const,
  saved: () => [...themeKeys.root, 'saved'] as const
}

export const savedThemesQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: themeKeys.saved(),
  query: ({ signal }) => api('/api/themes', { signal })
}))

export function useSavedThemes(active: MaybeRefOrGetter<boolean> = true) {
  const { loggedIn } = useUserSession()
  const query = useQuery(() => ({
    ...savedThemesQuery({ api: apiFetch }),
    enabled: import.meta.client && loggedIn.value && toValue(active)
  }))
  return { themes: computed(() => query.data.value?.themes ?? []), isLoading: query.isLoading }
}
```

- **The response type comes from the route.** `api('/api/themes')` returns `ApiResponse<'/api/themes', 'get'>`; never annotate the data by hand.
- **Pass `signal`.** A refetch aborts the request it replaces.
- **Session-gated reads are `enabled` only for a signed-in user, on the client.** They were never part of the server render; keeping them client-side means the server HTML and the first client render agree ("pending") and nothing hydrates differently. Wrappers return `null` / `[]` while signed out.
- **A component that stays mounted while hidden** (a dialog) passes `active` so it fetches when it opens, not when the page loads.
- **Queries read during the server render take `useApi()`**, which forwards the visitor's cookies there (`usePlanPricesQuery` on `/pricing`). `useQuery` runs them during SSR without an `await` (`onServerPrefetch`); the result travels in the Nuxt payload and the client hydrates it without a second request (the entry is fresh for `staleTime`). `await query.refresh()` in setup only when client-side navigation must wait for the data, as `/pricing` does.

Components use the composable (`useSavedThemes()`, `useBilling()`, `useAiCredits()`…), never `apiFetch` for a resource that has a query.

## Writing: add a mutation

Mutations live next to the reads they change, so one file knows a resource's key and its invalidation:

```ts
export function useCreateSavedTheme() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (body: CreateBody) => apiFetch('/api/themes', { method: 'post', body }),
    onSuccess: () => invalidate(cache, themeKeys.root)
  })
}
```

- Components call `await mutation.mutateAsync(vars)` inside their existing `try` / `catch`, so errors still go through `useErrorHandler` with the same texts. `isLoading` replaces a hand-rolled `saving` flag.
- `invalidate(cache, ...keys)` (`app/queries/invalidate.ts`) marks everything under each key stale, refetches what is on screen, and swallows refetch errors (the mutation itself succeeded; a failed refetch shows in that query's own error state).
- **Return the invalidation** when the caller should see the new data before it continues (a dialog that closes onto the refreshed list). **Fire and forget** (`void invalidate(…)`) when the caller navigates away or reports the result immediately.
- Invalidate **every** read the change touches, not just the obvious one: creating or deleting a workspace also moves the owned-workspace counter (`billingKeys.user()`); a plan change moves every AI budget (`useInvalidatePlan()`); a provider change moves availability in every workspace context.
- Prefer invalidation over patching the cache by hand (`setQueryData`). Patch only when the server's answer is the new state and a refetch would be wasted.

## Keys and defaults

- Keys are hierarchical: `[domain, resource, …params]`. Invalidating a prefix covers all its children (`aiKeys.credits()` covers every `aiKeys.creditsFor(workspaceId)`).
- Parameters are JSON values; `null` stands for "personal / no workspace".
- Defaults are decided once in `app/queries/defaults.ts` (handed to the plugin by `colada.options.ts` at the repo root):
  - `QUERY_DEFAULTS`: `staleTime` 5 s (components mounting together share one request), no refetch on window focus or reconnect (freshness comes from invalidation).
  - `SESSION_SNAPSHOT` for per-session snapshots (plan, account status, AI points, availability): never stale, never collected; only invalidation re-reads them.
  - `INSTANCE_CONFIG` for prices and tier caps: 10 minutes.
  - A query whose data changes through mutations it does not see uses `staleTime: 0` (the workspace list carries document counts) and is re-read whenever a view mounts.

## Sessions, SSR and logout

- The cache lives in the Pinia instance of one Nuxt app: one per server request (the module clears it after each render and disables garbage-collection timers on the server), one per browser tab.
- Logout is a hard reload (`useLogout`), which discards the cache; there is no persistence plugin, and none may be added without clearing it on logout. Other tabs reload through the logout broadcast.
- `@pinia/nuxt` is installed because Pinia Colada stores its caches in Pinia; the app defines no Pinia stores of its own.

## Tests

`tests/nuxt/queries.test.ts` shows the pattern: count endpoint hits with `registerEndpoint`, mount a tiny component that calls the composable, run the mutation, assert the dependent read was re-fetched. To give a component data without a request, put it in the cache: `useQueryCache().setQueryData(aiKeys.availabilityFor(null), …)`.
