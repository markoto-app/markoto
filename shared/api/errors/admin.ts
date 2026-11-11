// Error codes `admin/*`. Texts: `apiErrors.admin.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const adminErrors = defineErrors('admin', {
  'forbidden': { status: 403 },
  'spend-unavailable': { status: 502, params: z.object({ upstreamStatus: z.number() }) }
})
