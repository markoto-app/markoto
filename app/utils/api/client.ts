// Typed calls to our own API, keyed by the route PATTERN so the response type
// survives (a template-literal URL such as `/api/docs/${id}` widens to string
// and loses it):
//
//   const tokens = await apiFetch('/api/mcp/tokens')
//   await apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId }, body: { noDownload: true } })
//
// Responses: Nitro's `InternalApi` (inferred from each handler's return).
// Requests: `ApiInputs`, generated from the handlers' schemas by
// modules/api-contract.ts. Unconverted routes accept any body / query.
import type { $Fetch, InternalApi, NitroFetchOptions, NitroFetchRequest } from 'nitropack/types'
import type { ApiInputs, LegacyInput } from '~~/shared/api/contract'

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

export type ApiRoute = keyof InternalApi
export type ApiMethod<R extends ApiRoute> = Extract<keyof InternalApi[R], Method>
export type ApiResponse<R extends ApiRoute, M extends ApiMethod<R>> = InternalApi[R][M]

export type ApiRequest<R extends ApiRoute, M extends string> = R extends keyof ApiInputs
  ? M extends keyof ApiInputs[R] ? ApiInputs[R][M] : LegacyInput
  : LegacyInput

/** The `:name` segments of a route pattern. */
export type PathKeys<S extends string> = S extends `${string}:${infer P}/${infer T}`
  ? P | PathKeys<T>
  : S extends `${string}:${infer P}` ? P : never

type Field<T, K extends string> = T extends Record<K, infer V> ? V : T extends Partial<Record<K, infer V>> ? V : never

export interface ApiCall<R extends ApiRoute, M extends ApiMethod<R>>
  extends Omit<NitroFetchOptions<NitroFetchRequest>, 'body' | 'query' | 'params' | 'method'> {
  method?: M
  body?: Field<ApiRequest<R, M>, 'body'>
  query?: Field<ApiRequest<R, M>, 'query'>
}

/** `path` is required exactly when the pattern has parameters (not `params`: ofetch's `params` means query). */
type CallArgs<R extends ApiRoute, M extends ApiMethod<R>> = [PathKeys<R & string>] extends [never]
  ? [opts?: ApiCall<R, M>]
  : [opts: ApiCall<R, M> & { path: Record<PathKeys<R & string>, string | number> }]

function fillPath(route: string, path: Record<string, string | number> | undefined): string {
  return route.replace(/:(\w+)/g, (_whole, name: string) => {
    const value = path?.[name]
    if (value === undefined || value === '') throw new Error(`apiFetch ${route}: missing path parameter ${name}`)
    return encodeURIComponent(String(value))
  })
}

/**
 * A typed caller over `fetcher` (default: the global `$fetch`, looked up at
 * call time). An SSR caller that must forward cookies passes
 * `useRequestFetch()`; export a `useApi` for that when the first one needs it.
 */
function createApi(fetcher?: $Fetch) {
  return function api<R extends ApiRoute, M extends ApiMethod<R> = 'get' & ApiMethod<R>>(
    route: R,
    ...[opts]: CallArgs<R, M>
  ): Promise<ApiResponse<R, M>> {
    const { path, method, ...rest } = (opts ?? {}) as ApiCall<R, M> & { path?: Record<string, string | number> }
    const url = fillPath(route, path)
    // Plain call signature: the route-typed $Fetch overloads add nothing here
    // (the url is already filled in) and their inference is very deep.
    const f = (fetcher ?? $fetch) as unknown as (url: string, opts: object) => Promise<ApiResponse<R, M>>
    return f(url, { ...rest, method: method?.toUpperCase() })
  }
}

/** Client-side calls (event handlers, `onMounted`). */
export const apiFetch = createApi()
