// Error codes `brand/*`. Texts: `apiErrors.brand.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const brandErrors = defineErrors('brand', {
  'admin-required': { status: 403 },
  'family-built-in': { status: 409, params: z.object({ family: z.string(), field: z.string().optional() }) },
  'file-missing': { status: 400, audience: 'developer' },
  'file-too-large': { status: 413 },
  'font-exists': { status: 409 },
  'font-refused': { status: 422, params: z.object({ reason: z.string().optional(), messageKey: z.string().optional() }) },
  'image-type': { status: 415 },
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'invalid-family': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'invalid-weight': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'licence-required': { status: 400 },
  'no-design': { status: 409 },
  'rate-limited': { status: 429 },
  'too-many-fonts': { status: 409, params: z.object({ limit: z.number() }) },
  'too-many-images': { status: 409, params: z.object({ limit: z.number() }) }
})
