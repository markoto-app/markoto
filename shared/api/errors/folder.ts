// Error codes `folder/*`. Texts: `apiErrors.folder.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const folderErrors = defineErrors('folder', {
  'not-found': { status: 404 },
  'name-taken': { status: 409 },
  'too-deep': { status: 409, params: z.object({ max: z.number() }) },
  'cycle': { status: 409 },
  'forbidden': { status: 403 },
  'delete-blocked': { status: 403, params: z.object({ blocked: z.number() }) }
})
