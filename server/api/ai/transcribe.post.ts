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
import { litellmCompletion } from '../../utils/litellm/createCompletion'
import { budgetExhaustedMessage, budgetExhaustedMessageKey, limitRecovery } from '../../utils/billingMode'

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
  return await transcribeViaVoxtral({ audioB64, mimeType, languageCode, userId })
})

async function transcribeViaVoxtral(args: {
  audioB64: string
  mimeType: string
  languageCode: string
  userId: number
}): Promise<{ text: string, inaudible: boolean }> {
  // Phase 6 per-user billing: resolve the user's virtual key + use
  // it as the bearer token. LiteLLM bills the user's $ budget and
  // 4xx's with budget_exceeded if exhausted.
  const billing = await resolveBillingContext(args.userId, null)

  // Test-mode short-circuit. The integration stack runs a real
  // LiteLLM proxy, but the upstream Mistral key is a stub — so a
  // real /v1/audio/transcriptions call would 401 and the test loop
  // would time out waiting through SDK retries. The validation
  // tests only need the endpoint to RESPOND past its own ladder; we
  // satisfy that with a canned empty transcript when TEST_MODE=1.
  if (process.env.TEST_MODE === '1') {
    return { text: '', inaudible: true }
  }

  const litellm = useLitellmForUser(billing.virtualKey)
  const config = useRuntimeConfig()
  const transcribeModel = config.litellm?.transcribeModel || 'voxtral-mini-transcribe'

  // Translate the upstream BCP-47 codes (e.g. 'en-US') to Voxtral's
  // ISO shape ('en'). (BCP-47 was the contract pre-Phase-5 when the
  // path ran through Cloud STT; clients still send those codes.) The
  // custom provider passes this verbatim to Mistral.
  const isoLanguage = args.languageCode.split('-')[0]?.toLowerCase() || 'en'

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
