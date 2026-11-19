// Error codes `citations/*`. Texts: `apiErrors.citations.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const citationsErrors = defineErrors('citations', {
  'doi-invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'doi-not-found': { status: 404 },
  'doi-lookup-failed': { status: 502 },
  'rate-limited': { status: 429 }
})
