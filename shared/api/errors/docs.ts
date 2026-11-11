// Error codes `docs/*`. Texts: `apiErrors.docs.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const docsErrors = defineErrors('docs', {
  'not-found': { status: 404 },
  'content-too-long': { status: 400, params: z.object({ max: z.number() }) },
  'rate-limited': { status: 429 }
})
