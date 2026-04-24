// One-shot voice-to-text for the AI prompt bar. The user speaks, stops,
// and the recorded clip is sent here — Google Cloud Speech-to-Text
// transcribes it and the client auto-submits the transcript as a normal
// prompt. No Y.js session, no agentic loop: transcription doesn't touch
// the doc, and the downstream /api/ai/prompt call enforces the usual
// auth + content gates. That's why this route does NOT call
// `requireDocEditAccess`.
//
// Why Cloud STT (not Gemini inline-audio): three reasons.
//   1. Cheaper. Gemini billed per audio-token (~$0.10/min); Cloud STT
//      sync is ~$0.024/min for equivalent quality.
//   2. Purpose-built. Gemini can hallucinate "transcription" that isn't
//      actually what the user said; Cloud STT is trained on nothing
//      but transcription.
//   3. Unified with live dictation. Feature A already uses Cloud STT
//      (streamingRecognize); keeping both on the same vendor means
//      one quota, one billing line, one set of abuse controls.
//
// Why sync `recognize` (not streaming): the user clicks stop BEFORE we
// need the text — there's nothing to stream. Sync REST is simpler,
// works with API-key auth, and the full audio clip is bounded at 60s.
//
// MediaRecorder MIME → Cloud STT encoding mapping:
//   Chrome/Firefox produce `audio/webm;codecs=opus` → WEBM_OPUS
//   Safari produces `audio/mp4` (AAC) → Cloud STT has NO encoding for
//     MP4/AAC for sync recognize; for Safari we'd need to transcode
//     server-side or use the File API. For v1 we reject Safari's
//     format and tell the user to use Chrome/Firefox. TODO.

import * as Sentry from '@sentry/nuxt'
import { mimeToEncoding, normalizeLanguageCode } from '../../utils/agentic/transcribeHelpers'

const ALLOWED_MIME = [
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/wav',
  'audio/x-wav'
]

// Cap at ~5 MiB of raw audio. A 60-second opus/webm clip is typically
// ≤400 KiB, so this is generous — but the ceiling exists so a malicious
// client can't OOM the endpoint.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024

import { resolveBillingContext, chargeInteractions, interactionsForAudioMs, BudgetExhausted } from '../../utils/billing'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const config = useRuntimeConfig()

  if (!config.google.speechToTextApiKey) {
    throw createError({ statusCode: 500, message: 'Speech-to-Text API key not configured' })
  }

  // 60/hour is deliberately generous — voice input is a low-friction UX
  // and even an enthusiastic user is unlikely to hit it organically.
  // The real cost governor is the downstream `ai-prompt` bucket; this
  // limit is just abuse prevention.
  if (!(await checkRateLimit('ai-transcribe', String(userId), 60, 60 * 60 * 1000))) {
    throw createError({ statusCode: 429, message: 'Too many voice-input requests. Try again in a minute.' })
  }

  // Interaction budget pre-check. A 60s clip (worst case at the
  // MAX_AUDIO_BYTES ceiling) costs 5 interactions — require at least
  // that many remaining before we spend money on STT. Users near
  // their cap may see a false reject here on a short clip; they can
  // upgrade or wait for next period.
  const billing = await resolveBillingContext(userId, null)
  if (billing.interactionsRemaining < 5) {
    throw createError({
      statusCode: 402,
      message: 'Not enough AI actions remaining for a voice clip. Upgrade your plan at /pricing to continue.',
      data: { plan: billing.plan, remaining: billing.interactionsRemaining }
    })
  }

  const body = await readBody(event) as {
    audio?: string
    mimeType?: string
    languageCode?: string
  }

  const mimeType = body.mimeType
  const audioB64 = body.audio

  if (!mimeType || !ALLOWED_MIME.includes(mimeType.toLowerCase())) {
    throw createError({ statusCode: 400, message: 'Unsupported audio mimeType' })
  }
  const encoding = mimeToEncoding(mimeType)
  if (!encoding) {
    // Shouldn't happen — ALLOWED_MIME and mimeToEncoding are kept in
    // lockstep — but belt-and-braces so a code change to the allow-list
    // doesn't silently route to Cloud STT with a null encoding.
    throw createError({ statusCode: 400, message: 'Unsupported audio encoding' })
  }

  if (!audioB64 || typeof audioB64 !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing audio payload' })
  }

  // `atob` not available in Nitro's worker context; compute byte length
  // from the base64 string directly so we can reject oversize payloads
  // before reaching Cloud STT (which has its own 10 MiB hard cap for
  // sync recognize — but ours is tighter for abuse prevention).
  const padding = audioB64.endsWith('==') ? 2 : audioB64.endsWith('=') ? 1 : 0
  const approxBytes = Math.floor(audioB64.length * 3 / 4) - padding
  if (approxBytes > MAX_AUDIO_BYTES) {
    throw createError({ statusCode: 413, message: 'Audio too long (max ~5 MiB)' })
  }
  if (approxBytes < 100) {
    throw createError({ statusCode: 400, message: 'Audio too short to transcribe' })
  }

  // Cloud STT v1 sync recognize via REST. API-key auth as `?key=...`
  // in the URL. We don't need `sampleRateHertz` when the audio is
  // WEBM_OPUS/OGG_OPUS because the container carries it; for LINEAR16
  // we'd need to specify it, but we don't accept raw PCM over this
  // endpoint (only the streaming one does).
  const languageCode = normalizeLanguageCode(body.languageCode)
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 30_000)

  try {
    const res = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(config.google.speechToTextApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding,
            languageCode,
            enableAutomaticPunctuation: true,
            model: 'latest_short'
          },
          audio: { content: audioB64 }
        }),
        signal: abortController.signal
      }
    )

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('[transcribe] Cloud STT returned', res.status, errText.slice(0, 500))
      Sentry.captureMessage('[transcribe] Cloud STT non-2xx', {
        tags: { component: 'transcribe', event: 'stt_upstream_error', status: String(res.status) }
      })
      throw createError({ statusCode: 502, message: 'Transcription upstream error' })
    }

    type SttResponse = {
      results?: Array<{
        alternatives?: Array<{ transcript?: string }>
      }>
      totalBilledTime?: string // "Ns" — e.g. "15s"
    }
    const data = await res.json() as SttResponse

    // Cloud STT returns one result per utterance. We concatenate them
    // in order — for a 60s clip with a pause, we'd get two results
    // and want both joined. Each alternative[0] is the top hypothesis.
    const text = (data.results ?? [])
      .map(r => r.alternatives?.[0]?.transcript ?? '')
      .filter(Boolean)
      .join(' ')
      .trim()

    // Charge interactions based on the billed audio duration Cloud STT
    // reports back. Format is `"<N>s"` (e.g. `"15s"`). If we can't
    // parse it (malformed response, silence → no result), fall back to
    // 1 interaction flat so we don't give free transcribe cycles.
    const totalBilled = data.totalBilledTime ?? ''
    const billedSec = Number.parseFloat(totalBilled.replace(/s$/, '')) || 0
    const delta = Math.max(1, interactionsForAudioMs(billedSec * 1000))
    try {
      await chargeInteractions({
        attributedTo: billing.attributedTo,
        plan: billing.plan,
        delta,
        periodStart: billing.periodStart,
        reason: 'voice-input transcribe'
      })
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        // Race with concurrent charges (shouldn't happen for a single
        // user, but a `(+)` workspace with multiple active members can
        // drift us past the cap between the pre-check and the post-
        // charge). Log and let the response through — we'd rather
        // over-serve by a few seconds than lose the transcript.
        console.warn(`[transcribe] [billing] over-cap after STT succeeded: ${e.message}`)
        Sentry.captureMessage(`[transcribe] over-cap race: ${e.message}`, {
          level: 'warning',
          tags: { component: 'transcribe', event: 'billing_overcap_race' }
        })
      } else {
        throw e
      }
    }

    if (!text) {
      // No utterances detected at all — pure silence / noise. Same
      // contract as before: client shows a "didn't catch that" toast.
      return { text: '', inaudible: true }
    }

    return { text, inaudible: false }
  } finally {
    clearTimeout(timer)
  }
})

