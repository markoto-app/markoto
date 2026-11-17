// Error codes `ai/*`. Texts: `apiErrors.ai.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const aiErrors = defineErrors('ai', {
  'abort-not-initiator': { status: 403 },
  'audio-missing': { status: 400 },
  'audio-too-long': { status: 413 },
  'audio-too-short': { status: 400 },
  'audio-unsupported-type': { status: 400 },
  // `messageKey` picks the text of the billing mode (points reset, upgrade, coming soon).
  'budget-exhausted': { status: 402, params: z.object({ messageKey: z.string().optional(), recovery: recoveryParam.optional() }) },
  'comment-not-author': { status: 403 },
  'comment-trigger-not-eligible': { status: 404 },
  'confirmation-not-pending': { status: 409 },
  'duplicate-session': { status: 409 },
  'free-allowance-exhausted': { status: 402, params: z.object({ recovery: recoveryParam.optional() }) },
  'image-failed': { status: 502 },
  'image-provider-unavailable': { status: 502 },
  'image-rate-limited': { status: 429 },
  // Delegated AI jobs: one running job per user and per document.
  'job-busy': { status: 409 },
  'job-not-found': { status: 404 },
  'job-state': { status: 409, params: z.object({ status: z.string().optional() }) },
  'provider-error': { status: 502 },
  'provider-missing': { status: 409, params: z.object({ capability: z.string().optional(), recovery: recoveryParam.optional() }) },
  'session-not-found': { status: 404 },
  'transcription-failed': { status: 502 },
  'web-tools-rate-limited': { status: 429, params: z.object({ limit: z.number(), window: z.string(), recovery: recoveryParam.optional() }) }
})
