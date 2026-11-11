import { useValkey } from './valkey'
import { HOUR_SECONDS } from '../../shared/config/units'

// Per-document not-before cutoff for doc tokens. When a document's access
// becomes stricter, the app sends the cutoff (its own clock, epoch
// seconds — the same clock that stamps `iat`, so no app/sync skew enters
// the comparison) and every token issued before it stops opening the
// document: a visitor whose access just ended can't reconnect with the
// token still in their browser, while an entitled client fetches a fresh
// one. Kept in Valkey so every sync-server instance refuses the old
// tokens, also after a restart.
//
// Expiry: longer than any doc token lives (the app caps them at 2 h), after
// which every token the cutoff could refuse has expired anyway.
//
// Failure mode: fail OPEN. A Valkey outage must not lock every editor out
// of every document; the token's own expiry still bounds the access.

const KEY = (docId: string) => `sync:not-before:${docId}`
const NOT_BEFORE_TTL_SECONDS = 3 * HOUR_SECONDS

export async function readDocNotBefore(docId: string): Promise<number | null> {
  try {
    const raw = await useValkey().get(KEY(docId))
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch (e) {
    console.warn(`[not-before] read failed for ${docId}:`, e instanceof Error ? e.message : e)
    return null
  }
}

/** Returns false when the cutoff could not be stored. */
export async function writeDocNotBefore(docId: string, notBeforeSeconds: number): Promise<boolean> {
  try {
    await useValkey().set(KEY(docId), String(notBeforeSeconds), 'EX', NOT_BEFORE_TTL_SECONDS)
    return true
  } catch (e) {
    console.warn(`[not-before] write failed for ${docId}:`, e instanceof Error ? e.message : e)
    return false
  }
}
