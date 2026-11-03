import { and, desc, eq } from 'drizzle-orm'
import { consentLog } from '../db/schema'
import { useDatabase } from '../utils/database'
import { CONSENT_VERSION } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/anonId'
import { CONSENT_PURPOSES, OPTIONAL_CONSENT_PURPOSES, type ConsentPurpose } from '../utils/consentDecisions'

// Read the latest consent decision per purpose for the caller.
// Logged-in users are keyed on userId; anonymous users on a
// first-party `markoto-anon` cookie (set by `ensureAnonId` if not
// present). Each purpose's latest row wins.
//
// No UI calls this today: markoto uses essential storage only, so there
// is no cookie banner (CONSENT_VERSION 2). The endpoint stays so a future
// consent-based purpose can reuse the `consent_log` mechanism; it reports
// `promptRequired: false` while OPTIONAL_CONSENT_PURPOSES is empty.

interface PurposeState {
  purpose: ConsentPurpose
  granted: boolean
  version: number
}

export default defineEventHandler(async (event) => {
  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const anonId = await ensureAnonId(event)

  const db = useDatabase()
  const states: Partial<Record<ConsentPurpose, PurposeState>> = {}

  for (const purpose of CONSENT_PURPOSES) {
    const matchUser = userId === null
      ? eq(consentLog.anonId, anonId)
      : eq(consentLog.userId, userId)
    const row = (await db
      .select({ granted: consentLog.granted, version: consentLog.version })
      .from(consentLog)
      .where(and(matchUser, eq(consentLog.purpose, purpose)))
      .orderBy(desc(consentLog.createdAt))
      .limit(1)
    )[0]
    if (row) {
      states[purpose] = { purpose, granted: row.granted, version: row.version }
    }
  }

  // A prompt is needed only for purposes the visitor must actively decide
  // on, when no decision at the current version exists.
  const promptRequired = OPTIONAL_CONSENT_PURPOSES.some((p) => {
    const state = states[p]
    return state === undefined || state.version < CONSENT_VERSION
  })

  return {
    currentVersion: CONSENT_VERSION,
    promptRequired,
    decisions: states
  }
})
