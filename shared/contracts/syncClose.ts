/**
 * Reasons the sync server gives when it closes a document connection
 * because of what the client sent. The editor maps them to a user-facing
 * message and stops reconnecting — resending the same state would only
 * be rejected again.
 *
 * Wire shape: Hocuspocus delivers a server-side close to the provider as
 * a CLOSE message whose `reason` is one of these strings. An oversized
 * WebSocket frame never reaches Hocuspocus at all: the `ws` server closes
 * the socket with code 1009 (`WS_CLOSE_MESSAGE_TOO_BIG`).
 *
 * Dependency-free: imported by the sync server and the app.
 */
export const SYNC_CLOSE_REASONS = {
  /** One update is larger than SYNC_MAX_UPDATE_BYTES. */
  updateTooLarge: 'update-too-large',
  /** Applying the update would grow the document past SYNC_MAX_DOCUMENT_BYTES. */
  documentTooLarge: 'document-too-large',
  /** The update writes a document setting (title, theme, …) that fails validation. */
  invalidMeta: 'invalid-meta',
  /** The update can't be decoded or references state the server doesn't have. */
  invalidUpdate: 'invalid-update'
} as const

export type SyncCloseReason = typeof SYNC_CLOSE_REASONS[keyof typeof SYNC_CLOSE_REASONS]

/** Close codes (application range 4000–4999) paired with the reasons above. */
export const SYNC_CLOSE_CODES = {
  /** A document queued messages without sending its Auth frame in time (socket closed, reconnect). */
  authTimeout: 4408,
  payloadTooLarge: 4413,
  unprocessable: 4422
} as const

/**
 * Socket close reason when a document queued messages without sending
 * its Auth frame in time (`sync-server/src/pre-auth-guard.ts`). Not a
 * sync rejection: the editor reconnects as after any other disconnect.
 * Queuing too MUCH before authentication closes with `update-too-large`
 * instead.
 */
export const SYNC_AUTH_TIMEOUT_REASON = 'auth-timeout'

/** RFC 6455 "message too big" — sent by the `ws` server on frames above maxPayload. */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009

/**
 * Map a provider close event to a sync-rejection reason, or null for an
 * ordinary disconnect (network drop, server restart, …) that should just
 * reconnect.
 */
export function syncRejectionFromClose(event: { code?: unknown, reason?: unknown } | null | undefined): SyncCloseReason | null {
  if (!event) return null
  if (event.code === WS_CLOSE_MESSAGE_TOO_BIG) return SYNC_CLOSE_REASONS.updateTooLarge
  return Object.values(SYNC_CLOSE_REASONS).find(r => r === event.reason) ?? null
}
