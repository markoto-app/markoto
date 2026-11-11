// Error codes `design-import/*`. Texts: `apiErrors.design-import.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const designImportErrors = defineErrors('design-import', {
  'busy': { status: 409 },
  'content-mismatch': { status: 415 },
  'mismatch': { status: 415 },
  'no-vision': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) },
  'rate-limited': { status: 429 },
  'too-large': { status: 413 },
  'unsupported-format': { status: 415 }
})
