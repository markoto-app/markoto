// Error codes `audit/*`. Texts: `apiErrors.audit.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const auditErrors = defineErrors('audit', {
  'admin-required': { status: 403 },
  'invalid-query': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'rate-limited': { status: 429 },
  'too-many-rows': { status: 413, params: z.object({ max: z.number() }) }
})
