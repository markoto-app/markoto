// Handler files not yet converted to `defineApiHandler` (docs/contributing/api-handlers.md).
// Shrink-only: tests/unit/platform/apiRoutes.test.ts fails for a listed file that
// has been converted, and eslint.config.mjs reports the handler rules at `error` for
// every handler file NOT listed here. Sorted by path, one batch's lines together.

export const LEGACY_HANDLERS: readonly string[] = [
  'server/routes/scim/v2/ResourceTypes.get.ts',
  'server/routes/scim/v2/ServiceProviderConfig.get.ts',
  'server/routes/scim/v2/Users/[id].delete.ts',
  'server/routes/scim/v2/Users/[id].get.ts',
  'server/routes/scim/v2/Users/[id].patch.ts',
  'server/routes/scim/v2/Users/[id].put.ts',
  'server/routes/scim/v2/Users/index.get.ts',
  'server/routes/scim/v2/Users/index.post.ts'
]

/** Handlers that cannot use the wrapper at all, with the reason. Their own gating is reviewed by hand. */
export const RAW_HANDLER_EXCEPTIONS: Readonly<Record<string, string>> = {
  // A WebSocket handler (`defineEventHandler({ handler, websocket })`): the upgrade hook gets a raw Request,
  // so it authenticates with the short-lived JWT in the first message instead of a session.
  'server/routes/api/ai/dictate.ts': 'WebSocket: JWT in the first message, no H3 session'
}
