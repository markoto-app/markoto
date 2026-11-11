import type { H3Event } from 'h3'

/**
 * Route-param helpers that narrow `string | undefined` to `string`.
 *
 * `getRouterParam` can't prove a param is present. A missing one means a
 * mis-wired route, so 400. Passing `undefined` into drizzle's `eq()` would
 * silently build `WHERE col = NULL`. Use these wherever a route reads a path
 * param.
 */

export function requireRouteParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name)
  if (!value || typeof value !== 'string') {
    throw createError({ statusCode: 400, message: `Missing ${name}` })
  }
  return value
}

/** Shorthand for `requireRouteParam(event, 'docId')`. */
export function requireDocId(event: H3Event): string {
  return requireRouteParam(event, 'docId')
}

/** Shorthand for `requireRouteParam(event, 'wsId')`. */
export function requireWsId(event: H3Event): string {
  return requireRouteParam(event, 'wsId')
}
