// Error codes `published/*`. Texts: `apiErrors.published.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const publishedErrors = defineErrors('published', {
  'rate-limited': { status: 429 }
})
