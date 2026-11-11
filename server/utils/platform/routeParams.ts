import type { H3Event } from 'h3'

/**
 * Route-param helpers that narrow `string | undefined` to `string`.
 *
 * `getRouterParam` / `getRouterParams` return `string | undefined` because the
 * runtime can't prove a param is present in the URL template. In practice our
 * endpoints are always reached through a parameterized route (`[docId]`,
 * `[fileId]`, …) so undefined means the framework is broken or someone
 * mis-wired a route — a 400 is the honest response.
 *
 * Pre-helper, some endpoints accepted the `undefined` and passed it directly
 * into `drizzle`'s `eq()`, which typechecks on older versions but fails on
 * newer overloads and leaves a latent runtime hazard (the query becomes
 * `WHERE doc_id = NULL`, which never matches but still walks the index).
 *
 * Use these everywhere a route reads a path param.
 */

export function requireRouteParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name)
  if (!value || typeof value !== 'string') {
    throw createError({ statusCode: 400, message: `Missing ${name}` })
  }
  return value
}

/**
 * Shorthand for `requireRouteParam(event, 'docId')`. Most routes call it, so a
 * dedicated name avoids the string literal at every call site.
 */
export function requireDocId(event: H3Event): string {
  return requireRouteParam(event, 'docId')
}

/**
 * Shorthand for `requireRouteParam(event, 'wsId')`. Workspace routes.
 */
export function requireWsId(event: H3Event): string {
  return requireRouteParam(event, 'wsId')
}
