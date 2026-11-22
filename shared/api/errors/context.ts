// Error codes `context/*` (project context documents). Texts: `apiErrors.context.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const contextErrors = defineErrors('context', {
  'not-found': { status: 404 },
  'self': { status: 400 },
  'too-many': { status: 409, params: z.object({ max: z.number() }) },
  'not-attached': { status: 404 }
})
