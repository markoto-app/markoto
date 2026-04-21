import { GoogleGenAI } from '@google/genai'

// One-shot voice-to-text for the AI prompt bar. The user speaks, stops, and
// the recorded clip is sent here as base64 `inlineData` — Gemini transcribes
// it verbatim and the client auto-submits the transcript as a normal prompt.
// No Y.js session, no agentic loop: transcription doesn't touch the doc, and
// the downstream prompt call already enforces all the usual auth + content
// gates. That's why this route does NOT call `requireDocEditAccess`.

// Matches the MIME types browsers actually produce from `MediaRecorder`.
// Chrome/Firefox default to `audio/webm;codecs=opus`, Safari to `audio/mp4`.
// Keep the list tight — anything else is almost certainly an attempt to
// smuggle a non-audio payload through.
const ALLOWED_MIME = [
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav'
]

// Cap at ~5 MiB of raw audio. A 60-second opus webm clip is typically
// ≤400 KiB, so this is generous — but the ceiling exists so a malicious
// client can't OOM the inlineData path or burn Gemini quota.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024

const SYSTEM = `You are a speech-to-text transcriber. Transcribe the audio verbatim into the language that was spoken.
Return ONLY the spoken words — no preamble, no commentary, no quotation marks, no markdown.
If the audio contains only silence, background noise, or is otherwise unintelligible, return the single word "[inaudible]" and nothing else.
Punctuate naturally. Do not translate; preserve the original language.`

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const config = useRuntimeConfig()

  if (!config.google.apiKey) {
    throw createError({ statusCode: 500, message: 'Google API key not configured' })
  }

  // 60/hour is deliberately generous — voice input is a low-friction UX and
  // even an enthusiastic user is unlikely to hit it organically. The real
  // cost governor is the downstream `ai-prompt` bucket; this limit is
  // just abuse prevention.
  if (!(await checkRateLimit('ai-transcribe', String(userId), 60, 60 * 60 * 1000))) {
    throw createError({ statusCode: 429, message: 'Too many voice-input requests. Try again in a minute.' })
  }

  const body = await readBody(event) as {
    audio?: string
    mimeType?: string
  }

  const mimeType = body.mimeType
  const audioB64 = body.audio

  if (!mimeType || !ALLOWED_MIME.includes(mimeType.toLowerCase())) {
    throw createError({ statusCode: 400, message: 'Unsupported audio mimeType' })
  }
  if (!audioB64 || typeof audioB64 !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing audio payload' })
  }

  // `atob` not available in Nitro's worker context; compute byte length from
  // the base64 string directly so we can reject oversize payloads before we
  // allocate a Buffer.
  const padding = audioB64.endsWith('==') ? 2 : audioB64.endsWith('=') ? 1 : 0
  const approxBytes = Math.floor(audioB64.length * 3 / 4) - padding
  if (approxBytes > MAX_AUDIO_BYTES) {
    throw createError({ statusCode: 413, message: 'Audio too long (max ~5 MiB)' })
  }
  if (approxBytes < 100) {
    throw createError({ statusCode: 400, message: 'Audio too short to transcribe' })
  }

  const abortController = new AbortController()
  // 30s is well above the typical transcription latency (sub-second for a
  // 10s clip) but short enough that a wedged Gemini call doesn't hold a
  // user's mic button in "Transcribing…" forever.
  const timer = setTimeout(() => abortController.abort(), 30_000)

  try {
    const ai = new GoogleGenAI({ apiKey: config.google.apiKey })
    const response = await ai.models.generateContent({
      model: config.google.transcribeModel,
      contents: [{
        role: 'user',
        parts: [{
          inlineData: {
            mimeType,
            data: audioB64
          }
        }]
      }],
      config: {
        systemInstruction: SYSTEM,
        // Upper-bound the output — a 60s utterance tops out around ~250 words,
        // and any longer run is almost certainly a hallucination loop.
        maxOutputTokens: 1024,
        abortSignal: abortController.signal
      }
    })

    const text = (response.text ?? '').trim()
    if (!text || text === '[inaudible]') {
      // Clean client-side handling: UI can show a "didn't catch that" toast
      // without us having to shoehorn it into a generic 400.
      return { text: '', inaudible: true }
    }

    return { text, inaudible: false }
  } finally {
    clearTimeout(timer)
  }
})
