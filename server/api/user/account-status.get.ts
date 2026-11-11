import { getAccountStatus } from '../../repos/users'
import { isAdminUser } from '../../utils/auth/adminAccess'
import {
  DPA_VERSION,
  PRIVACY_VERSION,
  TOS_VERSION
} from '~~/shared/legal/versions'
import { legalSurfacesEnabled } from '../../utils/platform/instanceConfig'

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
    // `requireValidatedUserSession` guarantees the row, so a miss means it
    // was purged between validation and this query (deletion sweep): 500, not 404.
    throw createError({ statusCode: 500, message: 'User row vanished mid-request' })
  }

  // Legal surfaces off (self-hosted default): no onboarding gate, no DPA
  // step — every "required" flag is false. The accepted versions are
  // still reported as stored.
  const legal = legalSurfacesEnabled()

  return {
    // Drives the "Admin" entry in the avatar dropdown. Same source as
    // `requireAdminUser` (the `users.is_admin` column); see
    // server/utils/auth/adminAccess.ts.
    isAdmin: await isAdminUser(session.user.id),
    email: status.email,
    locale: status.locale,
    age: {
      confirmedAt: status.ageConfirmedAt?.toISOString() ?? null,
      confirmationRequired: legal && status.ageConfirmedAt === null
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
        acceptanceRequired: legal && (status.privacyVersionAccepted === null
          || status.privacyVersionAccepted < PRIVACY_VERSION)
      },
      tos: {
        currentVersion: TOS_VERSION,
        acceptedVersion: status.tosVersionAccepted,
        acceptedLocale: status.tosVersionAcceptedLocale,
        acceptanceRequired: legal && (status.tosVersionAccepted === null
          || status.tosVersionAccepted < TOS_VERSION)
      },
      dpa: {
        currentVersion: DPA_VERSION,
        acceptedVersion: status.dpaVersionAccepted,
        acceptedLocale: status.dpaVersionAcceptedLocale,
        // DPA acceptance is only required for workspace owners. The
        // endpoint reports the raw state; the UI gates the prompt on
        // "user owns ≥1 workspace" via a separate signal.
        acceptanceRequired: legal && (status.dpaVersionAccepted === null
          || status.dpaVersionAccepted < DPA_VERSION)
      }
    }
  }
})
