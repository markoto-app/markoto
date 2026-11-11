// Error codes `usage/*`. Texts: `apiErrors.usage.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const usageErrors = defineErrors('usage', {
  'admin-required': { status: 403 }
})
