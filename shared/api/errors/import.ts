// Error codes `import/*`. Texts: `apiErrors.import.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const importErrors = defineErrors('import', {
  'conversion-failed': { status: 422, statuses: [415], params: z.object({ detail: z.string() }) },
  'file-too-large': { status: 413 },
  'no-file': { status: 400 },
  'not-configured': { status: 503 },
  'not-utf8': { status: 422 },
  'rate-limited': { status: 429 },
  'timeout': { status: 504, statuses: [502] },
  'too-complex': { status: 413 },
  'unavailable': { status: 502, statuses: [504] },
  'unsupported-format': { status: 415 },
  // Bulk import jobs.
  'job-not-found': { status: 404 },
  'job-active': { status: 409 },
  'job-not-uploading': { status: 409 },
  'nothing-to-import': { status: 400 },
  'path-invalid': { status: 400 },
  'github-url-invalid': { status: 400 },
  'github-not-found': { status: 404 },
  'github-unavailable': { status: 502 }
})
