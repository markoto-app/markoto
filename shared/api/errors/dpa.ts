// Error codes `dpa/*`. Texts: `apiErrors.dpa.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const dpaErrors = defineErrors('dpa', {
  'version-stale': { status: 409, params: z.object({ currentVersion: z.unknown().optional() }) }
})
