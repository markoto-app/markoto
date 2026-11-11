// Error codes `onboarding/*`. Texts: `apiErrors.onboarding.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const onboardingErrors = defineErrors('onboarding', {
  'age-required': { status: 400 },
  'privacy-version-stale': { status: 409, params: z.object({ currentVersion: z.unknown().optional() }) },
  'required': { status: 403 },
  'tos-version-stale': { status: 409, params: z.object({ currentVersion: z.unknown().optional() }) }
})
