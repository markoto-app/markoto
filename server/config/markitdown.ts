// How long the app waits for the markitdown sidecar. The two callers differ on
// purpose: a document import waits a little longer than markitdown's own 60 s
// conversion limit (`MARKITDOWN_TIMEOUT_SECONDS`) so its 504 arrives instead of
// our abort; the knowledge pipeline aborts at the limit itself.
import { SECOND_MS } from '../../shared/config/units'

export const MARKITDOWN_IMPORT_TIMEOUT_MS = 75 * SECOND_MS
export const MARKITDOWN_KNOWLEDGE_TIMEOUT_MS = 60 * SECOND_MS
