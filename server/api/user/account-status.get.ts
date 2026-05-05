import { getAccountStatus } from '../../repos/users'
import { isAdminEmail } from '../../utils/adminAccess'
import {
  DPA_VERSION,
  PRIVACY_VERSION,
  TOS_VERSION
} from '~~/shared/legal/versions'

// Read the privacy-relevant state of the current user. Drives:
//   - the deletion-grace banner (when `deletionRequestedAt` is set)
//   - the age-confirmation interstitial (when `ageConfirmedAt` is null)
//   - the policy-acceptance prompts (when accepted version < current)
//   - the /settings/profile page (everything visible at once)
//
// One round-trip; the UI mounts this on app load and again when the
// user opens /settings/profile. Light enough to call freely.
//
// **Stale-version flags** are computed here so the UI doesn't need
// to import `shared/legal/versions.ts` directly. If we bump
// `PRIVACY_VERSION`, every signed-in user's next call to this endpoint
// returns `privacyAcceptanceRequired: true` and the UI gates further
// actions on a re-acceptance prompt.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const status = await getAccountStatus(session.user.id)
  if (!status) {
    // Defensively — `requireValidatedUserSession` already guarantees
    // the row exists, so this is a 500 rather than a 404 (the row was
    // deleted between the validation step and this query, which means
    // someone else just executed our deletion sweep).
    throw createError({ statusCode: 500, message: 'User row vanished mid-request' })
  }

  return {
    // Admin allowlist check — drives the "Admin" entry in the
    // avatar dropdown. Env-based; see server/utils/adminAccess.ts.
    isAdmin: isAdminEmail(status.email),
    email: status.email,
    locale: status.locale,
    age: {
      confirmedAt: status.ageConfirmedAt?.toISOString() ?? null,
      confirmationRequired: status.ageConfirmedAt === null
    },
    deletion: {
      requestedAt: status.deletionRequestedAt?.toISOString() ?? null,
      graceUntil: status.deletionGraceUntil?.toISOString() ?? null,
      pending: status.deletionRequestedAt !== null
    },
    policy: {
      privacy: {
        currentVersion: PRIVACY_VERSION,
        acceptedVersion: status.privacyVersionAccepted,
        acceptedLocale: status.privacyVersionAcceptedLocale,
        acceptanceRequired: status.privacyVersionAccepted === null
          || status.privacyVersionAccepted < PRIVACY_VERSION
      },
      tos: {
        currentVersion: TOS_VERSION,
        acceptedVersion: status.tosVersionAccepted,
        acceptedLocale: status.tosVersionAcceptedLocale,
        acceptanceRequired: status.tosVersionAccepted === null
          || status.tosVersionAccepted < TOS_VERSION
      },
      dpa: {
        currentVersion: DPA_VERSION,
        acceptedVersion: status.dpaVersionAccepted,
        acceptedLocale: status.dpaVersionAcceptedLocale,
        // DPA acceptance is only required for workspace owners. The
        // endpoint reports the raw state; the UI gates the prompt on
        // "user owns ≥1 workspace" via a separate signal.
        acceptanceRequired: status.dpaVersionAccepted === null
          || status.dpaVersionAccepted < DPA_VERSION
      }
    }
  }
})
