// Error codes `legal/*`. Texts: `apiErrors.legal.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const legalErrors = defineErrors('legal', {
  disabled: { status: 404 }
})
