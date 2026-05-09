import { and, desc, eq } from 'drizzle-orm'
import { consentLog } from '../db/schema'
import { useDatabase } from '../utils/database'
import { CONSENT_VERSION } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/anonId'

// Read the latest consent decision per purpose for the caller.
// Logged-in users are keyed on userId; anonymous users on a
// first-party `markoto-anon` cookie (set by `ensureAnonId` if not
// present). Each purpose's latest row wins.
//
// Used by the client-side consent banner to decide whether to show
// itself (no row at the current `consentVersion` → show banner) and
// by analytics/session-replay plugins to gate their loading.

interface PurposeState {
  purpose: 'essential' | 'analytics' | 'session_replay'
  granted: boolean
  version: number
}

export default defineEventHandler(async (event) => {
  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const anonId = await ensureAnonId(event)

  const db = useDatabase()
  // For each purpose, get the most-recent row. We do three queries
  // (one per purpose) so the indexes (user/purpose/createdAt and
  // anon/purpose/createdAt) match exactly. Could batch with
  // window functions but at three rows it's not worth it.
  const purposes: Array<PurposeState['purpose']> = ['essential', 'analytics', 'session_replay']
  const states: Record<string, PurposeState> = {}

  for (const purpose of purposes) {
    const row = (userId !== null
      ? await db
          .select({ granted: consentLog.granted, version: consentLog.version })
          .from(consentLog)
          .where(and(
            eq(consentLog.userId, userId),
            eq(consentLog.purpose, purpose)
          ))
          .orderBy(desc(consentLog.createdAt))
          .limit(1)
      : await db
          .select({ granted: consentLog.granted, version: consentLog.version })
          .from(consentLog)
          .where(and(
            eq(consentLog.anonId, anonId),
            eq(consentLog.purpose, purpose)
          ))
          .orderBy(desc(consentLog.createdAt))
          .limit(1)
    )[0]
    if (row) {
      states[purpose] = {
        purpose,
        granted: row.granted,
        version: row.version
      }
    }
  }

  // The banner shows if EITHER:
  //   - we have no record for the user (first visit / new device)
  //   - the recorded version is below the current consent version
  //     (we bumped — re-prompt to ensure they accept the updated
  //     scope of what each purpose covers).
  const hasAllAtCurrentVersion = purposes.every((p) => {
    const state = states[p]
    return state !== undefined && state.version >= CONSENT_VERSION
  })

  return {
    currentVersion: CONSENT_VERSION,
    promptRequired: !hasAllAtCurrentVersion,
    decisions: states
  }
})
