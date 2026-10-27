// One-shot voice-to-text for the AI prompt bar. The user speaks, stops,
// and the recorded clip is sent here — Voxtral (via LiteLLM) transcribes
// it and the client auto-submits the transcript as a normal prompt. No
// Y.js session, no agentic loop: transcription doesn't touch the doc,
// and the downstream /api/ai/prompt call enforces the usual auth +
// content gates. That's why this route does NOT call
// `requireDocEditAccess`.
//
// Phase 7: cloud-stt path + dual-mode flag dropped. Voxtral is the only
// path. Per-user billing is enforced inside LiteLLM via the user's
// virtual-key `max_budget`.

import * as Sentry from '@sentry/nuxt'
import { normalizeLanguageCode } from '../../utils/agentic/transcribeHelpers'
import { useLitellmForUser } from '../../utils/litellmClient'
import { resolveBillingContext } from '../../utils/billing'
import { isBudgetExceededError } from '../../utils/litellmKeys'
import { FEATURE_TAGS, featureMetadata } from '../../utils/litellm/featureTags'
import { litellmCompletion, litellmTranscription } from '../../utils/litellm/createCompletion'
import { providerMissingError, requireAiProviders } from '../../utils/aiProviders/guard'
import { providerRequestFields, withProviderErrors } from '../../utils/aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../utils/aiProviders/resolve'
import { budgetExhaustedMessage, budgetExhaustedMessageKey, limitRecovery } from '../../utils/billingMode'
import { isTestModeEnabled } from '../../../shared/utils/testMode'

const ALLOWED_MIME = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/wav',
  'audio/x-wav'
])

// Cap at ~5 MiB of raw audio. A 60-second opus/webm clip is typically
// ≤400 KiB, so this is generous — but the ceiling exists so a malicious
// client can't OOM the endpoint.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024

function base64Padding(b64: string): 0 | 1 | 2 {
  if (b64.endsWith('==')) return 2
  if (b64.endsWith('=')) return 1
  return 0
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  // Phase 6: app-side rate limit dropped. LiteLLM enforces an
  // rpm_limit (60/min) at the per-user-virtual-key level — see
  // `createUserKey` in `litellmKeys.ts`.

  const body = await readBody<{
    audio?: string
    mimeType?: string
    languageCode?: string
  }>(event)

  const mimeType = body.mimeType
  const audioB64 = body.audio

  if (!mimeType || !ALLOWED_MIME.has(mimeType.toLowerCase())) {
    throw createError({ statusCode: 400, message: 'Unsupported audio mimeType' })
  }
  if (!audioB64 || typeof audioB64 !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing audio payload' })
  }
  // `atob` not available in Nitro's worker context; compute byte length
  // from the base64 string directly so we can reject oversize payloads
  // before reaching upstream (each upstream has its own ceiling — ours is
  // tighter for abuse prevention).
  const padding = base64Padding(audioB64)
  const approxBytes = Math.floor(audioB64.length * 3 / 4) - padding
  if (approxBytes > MAX_AUDIO_BYTES) {
    throw createError({ statusCode: 413, message: 'Audio too long (max ~5 MiB)' })
  }
  if (approxBytes < 100) {
    throw createError({ statusCode: 400, message: 'Audio too short to transcribe' })
  }

  const languageCode = normalizeLanguageCode(body.languageCode)
  // BYOK: the user's transcription provider, else the instance default.
  // Neither → 409 `ai/provider-missing` (the mic button is hidden in that
  // case; this is the server-side backstop).
  const providers = await requireAiProviders(userId, 'transcription')
  const provider = providers.transcription
  if (!provider) throw providerMissingError('transcription')
  const billing = await resolveBillingContext(userId, null)
  // Translate the upstream BCP-47 codes (e.g. 'en-US') to the ISO shape
  // ('en') both the OpenAI transcription API and Voxtral expect.
  const isoLanguage = languageCode.split('-')[0]?.toLowerCase() || 'en'
  if (provider.credentials) {
    return await transcribeViaByok({ audioB64, mimeType, isoLanguage, provider, virtualKey: billing.virtualKey })
  }
  return await transcribeViaVoxtral({ audioB64, mimeType, isoLanguage, userId, model: provider.model, virtualKey: billing.virtualKey })
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
    form.append('file', new Blob([Buffer.from(args.audioB64, 'base64')], { type: args.mimeType }), `voice.${MIME_EXT[subtype] ?? 'webm'}`)
    form.append('model', fields.model)
    form.append('language', args.isoLanguage)
    if (fields.api_key) form.append('api_key', fields.api_key)
    if (fields.api_base) form.append('api_base', fields.api_base)
    const resp = await withProviderErrors(args.provider, () => litellmTranscription(useLitellmForUser(args.virtualKey), form))
    const text = (resp.text ?? '').trim()
    return text ? { text, inaudible: false } : { text: '', inaudible: true }
  } catch (e) {
    // Message is already key-free (withProviderErrors redacts it).
    console.error('[transcribe] BYOK provider error:', (e instanceof Error ? e.message : String(e)).slice(0, 300))
    throw createError({
      statusCode: 502,
      message: 'Your transcription provider returned an error. Check the provider settings.',
      data: { code: 'ai/provider-error', messageKey: 'aiProvider.errors.transcription' }
    })
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
  // Test-mode short-circuit. The integration stack runs a real
  // LiteLLM proxy, but the upstream Mistral key is a stub — so a
  // real /v1/audio/transcriptions call would 401 and the test loop
  // would time out waiting through SDK retries. The validation
  // tests only need the endpoint to RESPOND past its own ladder; we
  // satisfy that with a canned empty transcript when TEST_MODE=1.
  if (isTestModeEnabled()) {
    return { text: '', inaudible: true }
  }

  // Operator alias (platform-paid): billed against the user's LiteLLM
  // budget; LiteLLM 4xx's with budget_exceeded if exhausted.
  const litellm = useLitellmForUser(args.virtualKey)
  const transcribeModel = args.model
  const isoLanguage = args.isoLanguage

  // Custom provider convention: single user message with JSON-encoded
  // {audio_base64, mime, language}. See infra/litellm/custom_handlers.py:
  // MistralTranscribeProvider. The wrapper internally hits Mistral's
  // /v1/audio/transcriptions and reshapes the response so spend tracks.
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
      // No max_tokens — Voxtral's transcript length is bounded by the
      // input audio and we want the full transcript.
      temperature: 0,
      // LiteLLM spend-tags. Transcribe never carries a workspace
      // context (the prompt-bar mic isn't doc-scoped), so only
      // feature + user dimensions apply.
      ...featureMetadata(FEATURE_TAGS.transcribe, { userId: args.userId })
    })
    const text = (resp.choices?.[0]?.message?.content ?? '').trim()
    if (!text) {
      return { text: '', inaudible: true }
    }
    return { text, inaudible: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[transcribe] Voxtral upstream error:', msg.slice(0, 500))
    Sentry.captureMessage('[transcribe] Voxtral non-2xx', {
      tags: { component: 'transcribe', event: 'voxtral_upstream_error' }
    })
    if (isBudgetExceededError(e)) {
      throw createError({
        statusCode: 402,
        message: budgetExhaustedMessage(),
        data: {
          code: 'ai/budget-exhausted',
          messageKey: budgetExhaustedMessageKey(),
          recovery: limitRecovery()
        }
      })
    }
    throw createError({ statusCode: 502, message: 'Transcription upstream error' })
  }
}
