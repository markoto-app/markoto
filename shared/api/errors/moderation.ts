// Error codes `moderation/*`. Texts: `apiErrors.moderation.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const moderationErrors = defineErrors('moderation', {
  'not-restricted': { status: 404 },
  'note-required': { status: 400, params: z.object({ max: z.number() }) },
  'restricted': { status: 403 }
})
