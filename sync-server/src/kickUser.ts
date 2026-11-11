import type { Doc as YDoc } from 'yjs'
import type { StoreDebouncer } from './flushDocument'
import { closeForReauth, type ReauthConnection } from './connection-expiry'

// Pure in-memory kick-user logic. Lives in its own file so tests can import
// it without pulling in `persistence.ts` (which opens a Postgres connection
// at top level). Called from the `/internal/kick-user` HTTP handler.

// Minimal structural shape of the Hocuspocus instance we touch. The full
// Hocuspocus type graph is heavy and shifts between patch releases.
// `documents` values are actually `Document` (extends Y.Doc); we narrow
// structurally where `getConnections()` is used.
export type HocuspocusConnection = ReauthConnection
export interface HocuspocusDocument extends YDoc {
  getConnections?: () => HocuspocusConnection[]
}
export interface HocuspocusInstance {
  documents?: Map<string, HocuspocusDocument>
  // Method syntax: Hocuspocus' own `unloadDocument` takes its richer
  // `Document`; the instance we receive only ever passes docs it loaded.
  unloadDocument?(doc: HocuspocusDocument): unknown
  /** Hocuspocus' store debouncer (`/internal/flush-document`). */
  debouncer?: StoreDebouncer
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
    kicked += closeUserConnections(doc, targetUserId)
  }
  return { kicked, missing }
}

/** Close every connection on `doc` whose context userId matches; swallows individual close failures so one bad socket can't abort the sweep. Returns the number actually closed. */
function closeUserConnections(doc: HocuspocusDocument, targetUserId: string): number {
  let kicked = 0
  // Copy first: closing removes the connection from the live set.
  for (const conn of [...(doc.getConnections?.() ?? [])]) {
    if (!isOwnedBy(conn, targetUserId)) continue
    // The re-authenticate close makes the editor fetch a fresh token
    // before it reconnects, so a removed member lands on the no-access
    // screen instead of reconnecting with the token it still holds.
    if (closeForReauth(conn)) kicked++
  }
  return kicked
}

function isOwnedBy(conn: HocuspocusConnection, targetUserId: string): boolean {
  const id = conn.context?.userId
  return id != null && String(id) === targetUserId
}
