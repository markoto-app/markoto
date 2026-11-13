// Error codes `plan/*`. Texts: `apiErrors.plan.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const planErrors = defineErrors('plan', {
  'feature-unavailable': { status: 409, params: z.object({ feature: z.string().optional(), plan: z.string().optional(), recovery: recoveryParam.optional() }) },
  'limit-reached': { status: 409, statuses: [429], params: z.object({ field: z.string().optional(), limit: z.number().optional(), plan: z.string().optional(), recovery: recoveryParam.optional() }) }
})
