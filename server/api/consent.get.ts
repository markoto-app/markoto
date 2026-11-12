import { latestConsentDecision } from '../repos/consent'
import { CONSENT_VERSION } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/auth/anonId'
import { CONSENT_PURPOSES, OPTIONAL_CONSENT_PURPOSES, type ConsentPurpose } from '../utils/privacy/consentDecisions'

// Latest consent decision per purpose for the caller: keyed on userId when
// logged in, else on the first-party `markoto-anon` cookie (`ensureAnonId`).
//
// No UI calls this today: markoto uses essential storage only, so there is no
// cookie banner (CONSENT_VERSION 2). The endpoint stays so a future
// consent-based purpose can reuse `consent_log`; it reports
// `promptRequired: false` while OPTIONAL_CONSENT_PURPOSES is empty.

interface PurposeState {
  purpose: ConsentPurpose
  granted: boolean
  version: number
}

export default defineApiHandler({
  access: allow.public('Visitors read their own consent state, keyed on their account or their first-party anonymous cookie', { session: 'optional' }),
  handler: async ({ event, self }) => {
    const anonId = await ensureAnonId(event)
    const states: Partial<Record<ConsentPurpose, PurposeState>> = {}

    for (const purpose of CONSENT_PURPOSES) {
      const row = await latestConsentDecision({ self, anonId }, purpose)
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
  }
})
