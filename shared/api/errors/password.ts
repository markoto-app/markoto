// Error codes `password/*`. Texts: `apiErrors.password.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const passwordErrors = defineErrors('password', {
  'invalid': { status: 401 },
  'locked': { status: 429 },
  'rate-limited': { status: 429 },
  'too-short': { status: 400, params: z.object({ minLength: z.number() }) },
  'required': { status: 400 },
  'not-set': { status: 400 }
})
