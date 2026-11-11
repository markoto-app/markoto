// Handler files that cannot use `defineApiHandler` at all, with the reason
// (docs/contributing/api-handlers.md). Their own gating is reviewed by hand;
// eslint.config.mjs exempts them from the handler-contract rules.

export const RAW_HANDLER_EXCEPTIONS: Readonly<Record<string, string>> = {
  // A WebSocket handler (`defineEventHandler({ handler, websocket })`): the upgrade hook gets a raw Request,
  // so it authenticates with the short-lived JWT in the first message instead of a session.
  'server/routes/api/ai/dictate.ts': 'WebSocket: JWT in the first message, no H3 session'
}
