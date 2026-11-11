// Error codes `files/*`. Texts: `apiErrors.files.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const filesErrors = defineErrors('files', {
  'access-denied': { status: 403 }
})
