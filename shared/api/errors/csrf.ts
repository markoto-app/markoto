// Error codes `csrf/*`. Texts: `apiErrors.csrf.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const csrfErrors = defineErrors('csrf', {
  'origin-mismatch': { status: 403, audience: 'developer' }
})
