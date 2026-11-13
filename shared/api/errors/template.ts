// Error codes `template/*`. Texts: `apiErrors.template.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const templateErrors = defineErrors('template', {
  'doc-not-found': { status: 404 },
  'exists': { status: 409 },
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'too-many': { status: 409, params: z.object({ limit: z.number() }) }
})
