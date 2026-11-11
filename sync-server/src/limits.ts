// Size limits for what a client may push into a document.
//
// Before these existed, any writer (including an anonymous editor of an
// open-edit doc) could insert an arbitrarily large string. The in-memory
// Y.Doc plus the full-state encode on every debounced store pushed the
// container into an OOM kill — taking down every document on that
// instance, not just the attacker's.
//
// Three layers, outermost first:
//   SYNC_MAX_MESSAGE_BYTES  — WebSocket frame size (`ws` maxPayload). The
//                             socket is closed with 1009 before the frame
//                             is buffered further or parsed.
//   SYNC_MAX_UPDATE_BYTES   — one Y.js update (sync step 2 / update).
//   SYNC_MAX_DOCUMENT_BYTES — encoded document state after the update.
//                             Updates that only delete are still accepted
//                             so an oversized document can be trimmed.
//
// Defaults are generous: the editor warns at 5 MB and flags 8 MB as
// critical (`shared/utils/documentHelpers.ts#docSizeWarning`); a document
// can grow to twice that before writes are refused. A restore re-sends a
// whole document as one update, so the update cap equals the doc cap.

const MIB = 1024 * 1024

export const DEFAULT_MAX_DOCUMENT_BYTES = 16 * MIB
const DEFAULT_MAX_UPDATE_BYTES = 16 * MIB
/** Frame overhead on top of the update: document name + message framing. */
const DEFAULT_MAX_MESSAGE_BYTES = 17 * MIB

export interface SyncLimits {
  maxMessageBytes: number
  maxUpdateBytes: number
  maxDocumentBytes: number
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export function parseSyncLimits(env: Record<string, string | undefined>): SyncLimits {
  return {
    maxMessageBytes: positiveInt(env.SYNC_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES),
    maxUpdateBytes: positiveInt(env.SYNC_MAX_UPDATE_BYTES, DEFAULT_MAX_UPDATE_BYTES),
    maxDocumentBytes: positiveInt(env.SYNC_MAX_DOCUMENT_BYTES, DEFAULT_MAX_DOCUMENT_BYTES)
  }
}
