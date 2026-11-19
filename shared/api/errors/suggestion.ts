// Error codes `suggestion/*`. Texts: `apiErrors.suggestion.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const suggestionErrors = defineErrors('suggestion', {
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'not-allowed': { status: 403 },
  'review-not-allowed': { status: 403 },
  'not-found': { status: 404 },
  'too-many': { status: 409, params: z.object({ max: z.number() }) },
  'too-many-authors': { status: 409, params: z.object({ max: z.number() }) },
  'rate-limited': { status: 429 }
})
