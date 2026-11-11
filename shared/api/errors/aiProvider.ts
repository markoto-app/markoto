// Error codes `ai-provider/*`. Texts: `apiErrors.ai-provider.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const aiProviderErrors = defineErrors('ai-provider', {
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'key-required': { status: 400 },
  'rate-limited': { status: 429 },
  'url-refused': { status: 422, params: z.object({ reason: z.string().optional() }) },
  'verify-failed': { status: 422, params: z.object({ reason: z.string().optional() }) }
})
