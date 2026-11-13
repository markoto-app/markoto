// One-shot voice-to-text for the AI prompt bar: Voxtral (via LiteLLM)
// transcribes a recorded clip and the client submits the transcript as a normal
// prompt. No Y.js session or agentic loop; transcription doesn't touch the doc
// and the downstream /api/ai/prompt call enforces the usual auth + content
// gates, so this route asks for no document access (`allow.user()`). Per-user billing
// is the user's virtual-key `max_budget` inside LiteLLM.

import * as Sentry from '@sentry/nuxt'
import { normalizeLanguageCode } from '../../utils/agentic/dictateHelpers'
import { useLitellmForUser } from '../../utils/ai/litellmClient'
import { resolveBillingContext } from '../../utils/billing/billing'
import { isBudgetExceededError } from '../../utils/litellm/userKeys'
import { isFreeAllowanceExhaustedError } from '../../utils/litellm/freeTierTeam'
import { freeAllowanceExhaustedHttpError } from '../../utils/billing/freeAllowance'
import { FEATURE_TAGS, featureMetadata } from '../../utils/litellm/featureTags'
import { litellmCompletion, litellmTranscription } from '../../utils/litellm/createCompletion'
import { providerMissingError, requireAiProviders } from '../../utils/aiProviders/guard'
import { providerRequestFields, withProviderErrors } from '../../utils/aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../utils/aiProviders/resolve'
import { budgetExhaustedMessageKey, limitRecovery } from '../../utils/billing/billingMode'
import { isTestModeEnabled } from '../../../shared/utils/security/testMode'
import { TRANSCRIBE_AUDIO_MAX_BYTES } from '~~/shared/config/uploads'
import { transcribeBody } from '~~/shared/api/ai'
import { ownValue } from '~~/shared/utils/ownValue'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('transcribe')

const ALLOWED_MIME = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/wav',
  'audio/x-wav'
])

function base64Padding(b64: string): 0 | 1 | 2 {
  if (b64.endsWith('==')) return 2
  if (b64.endsWith('=')) return 1
  return 0
}

export default defineApiHandler({
  // Not document-bound: the clip is only transcribed, the prompt that follows
  // passes the document gates.
  access: allow.user(),
  body: transcribeBody,
  handler: async ({ user, self, body }) => {
    const userId = user.id

    // The per-user virtual key's rpm_limit (60/min, `createUserKey` in
    // `litellm/userKeys.ts`) is the only rate limit.

    const mimeType = body.mimeType
    const audioB64 = body.audio

    if (!mimeType || !ALLOWED_MIME.has(mimeType.toLowerCase())) throw apiError('ai/audio-unsupported-type')
    if (!audioB64) throw apiError('ai/audio-missing')
    // `atob` isn't available in Nitro's worker context; compute the byte length
    // from the base64 string to reject oversize payloads before upstream.
    const padding = base64Padding(audioB64)
    const approxBytes = Math.floor(audioB64.length * 3 / 4) - padding
    if (approxBytes > TRANSCRIBE_AUDIO_MAX_BYTES) {
      throw apiError('ai/audio-too-long')
    }
    if (approxBytes < 100) {
      throw apiError('ai/audio-too-short')
    }

    const languageCode = normalizeLanguageCode(body.languageCode)
    // BYOK: the user's transcription provider, else the instance default.
    // Neither → 409 `ai/provider-missing` (the mic button is hidden in that
    // case; this is the server-side backstop).
    // The plan that pays: the open document's Team / Business workspace when
    // the caller is a member of it (`workspaceId` is advisory,
    // resolveBillingContext checks membership), else the caller's own.
    const workspaceId = body.workspaceId ?? null
    const billing = await resolveBillingContext(userId, workspaceId)
    const providers = await requireAiProviders(self, 'transcription', billing.plan)
    const provider = providers.transcription
    if (!provider) throw providerMissingError('transcription')
    // Translate the upstream BCP-47 codes (e.g. 'en-US') to the ISO shape
    // ('en') both the OpenAI transcription API and Voxtral expect.
    const isoLanguage = languageCode.split('-')[0]?.toLowerCase() || 'en'
    if (provider.credentials) {
      return await transcribeViaByok({ audioB64, mimeType, isoLanguage, provider, virtualKey: billing.virtualKey })
    }
    return await transcribeViaVoxtral({ audioB64, mimeType, isoLanguage, userId, model: provider.model, virtualKey: billing.virtualKey })
  }
})

const MIME_EXT: Record<string, string> = { 'webm': 'webm', 'ogg': 'ogg', 'wav': 'wav', 'x-wav': 'wav' }

/**
 * BYOK path: the user's OpenAI-compatible `/audio/transcriptions` via
 * LiteLLM's zero-cost `byok/*` deployment (clientside credentials ride
 * as multipart form fields next to the audio file).
 */
async function transcribeViaByok(args: {
  audioB64: string
  mimeType: string
  isoLanguage: string
  provider: ResolvedAiProvider
  virtualKey: string
}): Promise<{ text: string, inaudible: boolean }> {
  try {
    // Inside the try: the request-time SSRF re-check may refuse a stored
    // base URL whose DNS changed since it was saved.
    const fields = await providerRequestFields(args.provider)
    const subtype = args.mimeType.split(';')[0]?.split('/')[1] ?? 'webm'
    const form = new FormData()
    form.append('file', new Blob([Buffer.from(args.audioB64, 'base64')], { type: args.mimeType }), `voice.${ownValue(MIME_EXT, subtype) ?? 'webm'}`)
    form.append('model', fields.model)
    form.append('language', args.isoLanguage)
    if (fields.api_key) form.append('api_key', fields.api_key)
    if (fields.api_base) form.append('api_base', fields.api_base)
    const resp = await withProviderErrors(args.provider, () => litellmTranscription(useLitellmForUser(args.virtualKey), form))
    const text = (resp.text ?? '').trim()
    return text ? { text, inaudible: false } : { text: '', inaudible: true }
  } catch (e) {
    // Message is already key-free (withProviderErrors redacts it).
    log.error('BYOK provider error', { err: e })
    throw apiError('ai/provider-error')
  }
}

async function transcribeViaVoxtral(args: {
  audioB64: string
  mimeType: string
  isoLanguage: string
  userId: number
  model: string
  virtualKey: string
}): Promise<{ text: string, inaudible: boolean }> {
  // Test-mode short-circuit: the integration LiteLLM proxy has a stub Mistral
  // key, so a real call would 401 and stall on SDK retries; validation tests
  // only need a response, so return a canned empty transcript.
  if (isTestModeEnabled()) {
    return { text: '', inaudible: true }
  }

  // Operator alias (platform-paid): billed against the user's LiteLLM budget,
  // which 4xx's with budget_exceeded when exhausted.
  const litellm = useLitellmForUser(args.virtualKey)
  const transcribeModel = args.model
  const isoLanguage = args.isoLanguage

  // Custom provider convention: one user message with JSON-encoded
  // {audio_base64, mime, language}; MistralTranscribeProvider
  // (deploy/config/litellm/custom_handlers.py) wraps /v1/audio/transcriptions and
  // reshapes the response so spend tracks.
  try {
    const resp = await litellmCompletion(litellm, {
      model: transcribeModel,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          audio_base64: args.audioB64,
          mime: args.mimeType,
          language: isoLanguage
        })
      }],
      // No max_tokens: the transcript is bounded by the audio.
      temperature: 0,
      // Spend tags: feature + user only; the mic isn't doc-scoped.
      ...featureMetadata(FEATURE_TAGS.transcribe, { userId: args.userId })
    })
    const text = (resp.choices?.[0]?.message?.content ?? '').trim()
    if (!text) {
      return { text: '', inaudible: true }
    }
    return { text, inaudible: false }
  } catch (e) {
    log.error('Voxtral upstream error', { err: e })
    Sentry.captureMessage('[transcribe] Voxtral non-2xx', {
      tags: { component: 'transcribe', event: 'voxtral_upstream_error' }
    })
    if (isFreeAllowanceExhaustedError(e)) throw freeAllowanceExhaustedHttpError()
    if (isBudgetExceededError(e)) {
      throw apiError('ai/budget-exhausted', { messageKey: budgetExhaustedMessageKey(), recovery: limitRecovery() })
    }
    throw apiError('ai/transcription-failed')
  }
}
