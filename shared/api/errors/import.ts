// Error codes `import/*`. Texts: `apiErrors.import.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const importErrors = defineErrors('import', {
  'file-too-large': { status: 413 },
  'no-file': { status: 400 },
  'not-utf8': { status: 422 },
  'rate-limited': { status: 429 },
  'timeout': { status: 504, statuses: [502] },
  'too-complex': { status: 413 },
  'unavailable': { status: 502, statuses: [504] },
  'unsupported-format': { status: 415 }
})
