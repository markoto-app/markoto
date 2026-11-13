// Error codes `publish/*`. Texts: `apiErrors.publish.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const publishErrors = defineErrors('publish', {
  'busy': { status: 409 },
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'not-allowed': { status: 403 },
  'not-published': { status: 404, statuses: [409] },
  'rate-limited': { status: 429 },
  'render-failed': { status: 502 },
  'slug-invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'slug-taken': { status: 409 },
  'too-large': { status: 413 }
})
