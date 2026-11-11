// Error codes `docs/*`. Texts: `apiErrors.docs.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const docsErrors = defineErrors('docs', {
  'not-found': { status: 404 },
  'content-too-long': { status: 400, params: z.object({ max: z.number() }) },
  'rate-limited': { status: 429 },
  'edit-forbidden': { status: 403 },
  'manage-forbidden': { status: 403 },
  'delete-forbidden': { status: 403 },
  'activity-not-found': { status: 404 },
  'diff-unavailable': { status: 410 },
  'restore-unavailable': { status: 410 },
  'restore-compacted': { status: 410 },
  'not-a-comment': { status: 410 },
  'comment-thread-gone': { status: 410 },
  'render-failed': { status: 502 }
})
