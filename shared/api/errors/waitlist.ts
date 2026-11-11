// Error codes `waitlist/*`. Texts: `apiErrors.waitlist.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const waitlistErrors = defineErrors('waitlist', {
  'consent-required': { status: 400 },
  'disabled': { status: 404 },
  'invalid-email': { status: 400 },
  'invalid-token': { status: 400 },
  'rate-limited': { status: 429 }
})
