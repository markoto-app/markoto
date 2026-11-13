import { legalSurfacesEnabled } from '../utils/platform/instanceConfig'
import { getValidatedOnboardingState } from '../utils/auth/validatedSession'
import { isOnboardingGatedRequest, onboardingIncomplete, ONBOARDING_REQUIRED_CODE } from '../utils/privacy/onboardingGate'

// Server-side onboarding gate (hosted shape only). A signed-in user who
// hasn't confirmed their age or accepted the current Privacy Policy +
// Terms gets 403 `onboarding/required` on every state-changing `/api`
// call (incl. every AI entry point) except the exempt ones in
// `utils/onboardingGate.ts`. No-op when the legal surfaces are off
// (self-hosted: the operator runs their own terms, there is no gate).
// Runs after `auth.ts` (filename order), so protected routes have
// already answered 401 for anonymous callers.

export default defineEventHandler(async (event) => {
  if (!legalSurfacesEnabled()) return
  const path = getRequestURL(event).pathname
  if (!isOnboardingGatedRequest(event.method, path)) return

  const state = await getValidatedOnboardingState(event)
  if (!state || !onboardingIncomplete(state)) return

  throw createError({
    statusCode: 403,
    message: 'Please confirm your age and accept the current Privacy Policy and Terms of Service first.',
    data: { code: ONBOARDING_REQUIRED_CODE }
  })
})
