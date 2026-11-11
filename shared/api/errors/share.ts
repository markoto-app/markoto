// Error codes `share/*`. Texts: `apiErrors.share.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const shareErrors = defineErrors('share', {
  'download-disabled': { status: 403 },
  'expired': { status: 403 },
  'expiry-past': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'expiry-too-far': { status: 400, params: z.object({ maxDays: z.number(), field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'not-a-guest': { status: 404 },
  'not-allowed': { status: 403 },
  'rate-limited': { status: 429 }
})
