import type { SyncEnv } from '../../shared/env/registry'
import { sync } from '../../shared/env/vars/sync'

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
// critical (`shared/utils/documents/documentHelpers.ts#docSizeWarning`); a document
// can grow to twice that before writes are refused. A restore re-sends a
// whole document as one update, so the update cap equals the doc cap.

// Defaults live in the env registry (shared/env/vars/sync.ts): 17 MiB frame
// (update + document name + framing), 16 MiB update, 16 MiB document.
export const DEFAULT_MAX_DOCUMENT_BYTES = sync.vars.maxDocumentBytes.default

export interface SyncLimits {
  maxMessageBytes: number
  maxUpdateBytes: number
  maxDocumentBytes: number
}

export function parseSyncLimits(env: SyncEnv): SyncLimits {
  return {
    maxMessageBytes: env.sync.maxMessageBytes,
    maxUpdateBytes: env.sync.maxUpdateBytes,
    maxDocumentBytes: env.sync.maxDocumentBytes
  }
}
