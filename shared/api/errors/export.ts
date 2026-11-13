// Error codes `export/*`. Texts: `apiErrors.export.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const exportErrors = defineErrors('export', {
  'conflict': { status: 409 },
  'expired': { status: 410 },
  'not-found': { status: 404 },
  'not-ready': { status: 409, params: z.object({ status: z.string().optional() }) },
  'rate-limited': { status: 429 }
})
