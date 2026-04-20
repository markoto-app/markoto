import type { Doc as YDoc } from 'yjs'

// Pure in-memory kick-user logic. Lives in its own file so tests can import
// it without pulling in `persistence.ts` (which opens a Postgres connection
// at top level). Called from the `/internal/kick-user` HTTP handler.

// Minimal structural shape of the Hocuspocus instance we touch. The full
// Hocuspocus type graph is heavy and shifts between patch releases.
// `documents` values are actually `Document` (extends Y.Doc); we narrow
// structurally where `getConnections()` is used.
export interface HocuspocusConnection {
  context?: { userId?: string | number | null }
  close?: () => void
}
export interface HocuspocusDocument extends YDoc {
  getConnections?: () => HocuspocusConnection[]
}
export interface HocuspocusInstance {
  documents?: Map<string, HocuspocusDocument>
  unloadDocument?: (doc: YDoc) => void
}

/**
 * Iterate loaded docs and close every connection owned by `targetUserId`.
 * `targetUserId` must already be stringified (JWT payload carries number
 * for logged-in users and the sentinel 'anonymous' string; both normalise
 * to string for comparison).
 *
 * Returns counters for the HTTP response — useful for the caller to detect
 * "kicked nobody" cases (most often means the member was never connected
 * to those docs in this session, which is fine).
 */
export function performKickUser(
  instance: HocuspocusInstance,
  targetUserId: string,
  targetDocIds: string[]
): { kicked: number, missing: number } {
  let kicked = 0
  let missing = 0
  for (const docId of targetDocIds) {
    const doc = instance.documents?.get(docId)
    if (!doc) {
      missing++
      continue
    }
    const connections = doc.getConnections?.() ?? []
    for (const conn of connections) {
      const connUserId = conn.context?.userId
      if (connUserId != null && String(connUserId) === targetUserId) {
        try {
          conn.close?.()
          kicked++
        } catch (e) {
          console.warn(`[internal-http] kick-user close failed:`, e instanceof Error ? e.message : e)
        }
      }
    }
  }
  return { kicked, missing }
}
