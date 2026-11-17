// Error codes `admin/*`. Texts: `apiErrors.admin.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const adminErrors = defineErrors('admin', {
  forbidden: { status: 403 }
})
