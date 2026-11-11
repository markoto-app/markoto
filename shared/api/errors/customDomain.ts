// Error codes `custom-domain/*`. Texts: `apiErrors.custom-domain.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const customDomainErrors = defineErrors('custom-domain', {
  'disabled': { status: 404 },
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'limit': { status: 409, params: z.object({ limit: z.number() }) },
  'not-found': { status: 404 },
  'not-verified': { status: 409 },
  'page-not-allowed': { status: 403 },
  'page-not-published': { status: 409 },
  'rate-limited': { status: 429 },
  'reserved': { status: 400, params: z.object({ field: z.string().optional() }) },
  'taken': { status: 409 }
})
