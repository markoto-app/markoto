// Error codes `theme/*`. Texts: `apiErrors.theme.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const themeErrors = defineErrors('theme', {
  'custom-css-invalid': { status: 400, params: z.object({ issues: z.unknown() }) },
  'image-not-in-doc': { status: 400 },
  'name-required': { status: 400 },
  'name-too-long': { status: 400 },
  'name-not-a-string': { status: 400, audience: 'developer' },
  'description-too-long': { status: 400 },
  'description-not-a-string': { status: 400, audience: 'developer' }
})
