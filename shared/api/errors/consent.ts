// Error codes `consent/*`. Texts: `apiErrors.consent.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const consentErrors = defineErrors('consent', {
  'rate-limited': { status: 429 }
})
