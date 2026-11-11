// Error codes `consent/*`. Texts: `apiErrors.consent.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const consentErrors = defineErrors('consent', {
  'no-decisions': { status: 400 },
  'no-valid-decisions': { status: 400 },
  'rate-limited': { status: 429 }
})
