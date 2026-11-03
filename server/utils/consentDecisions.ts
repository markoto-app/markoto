// Input normalisation for `POST /api/consent`. The endpoint is public and
// append-only, so the payload is bounded: at most one row per purpose per
// submission (last decision for a purpose wins), unknown purposes and
// non-boolean values dropped, and oversized arrays refused outright.

//
// Purposes markoto records today. Only `essential` remains: no analytics
// or session-replay script is loaded anywhere, so there is nothing to ask
// consent for (CONSENT_VERSION 2, see shared/legal/versions.ts) and the
// cookie banner was removed. `consent_log` keeps the rows written under
// version 1 (incl. the retired `analytics` / `session_replay` purposes)
// for the Art.7(1) record; new writes can only use the purposes below.
// Adding a consent-based purpose again = add it here AND to
// OPTIONAL_CONSENT_PURPOSES, bump CONSENT_VERSION, bring back a banner.
export const CONSENT_PURPOSES = ['essential'] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

/** Purposes a visitor must actively decide on. Empty: nothing to prompt for. */
export const OPTIONAL_CONSENT_PURPOSES: readonly ConsentPurpose[] = []

export interface ConsentDecision {
  purpose: ConsentPurpose
  granted: boolean
}

/** Anything longer than this is not a real banner submission. */
export const MAX_CONSENT_DECISIONS_IN = 10

function isPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value)
}

/**
 * Returns the deduplicated valid decisions (≤ one per purpose, in first-
 * seen purpose order), or null when the payload isn't an acceptable array.
 */
export function normaliseConsentDecisions(raw: unknown): ConsentDecision[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CONSENT_DECISIONS_IN) return null
  const byPurpose = new Map<ConsentPurpose, boolean>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (!isPurpose(record.purpose) || typeof record.granted !== 'boolean') continue
    byPurpose.set(record.purpose, record.granted)
  }
  return [...byPurpose].map(([purpose, granted]) => ({ purpose, granted }))
}
