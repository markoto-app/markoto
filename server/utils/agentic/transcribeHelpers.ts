// Pure helpers for the one-shot voice-to-text endpoint
// (POST /api/ai/transcribe). Same split rationale as
// `dictateHelpers.ts` — extracted so unit tests don't pull in Nuxt
// runtime + auth machinery just to assert on MIME/language mapping.
//
// `normalizeLanguageCode` is re-exported from `dictateHelpers.ts`
// because both endpoints need identical locale handling; changing
// either would produce inconsistent behavior between live dictation
// and one-shot prompt transcription.
export { normalizeLanguageCode } from './dictateHelpers'

/**
 * Map a client-reported MIME type to the upstream's encoding enum. We
 * default to WEBM_OPUS for unspecified opus containers because that's
 * what modern Chrome/Firefox MediaRecorder outputs natively. (Enum
 * names are pre-Phase-5 Cloud STT shapes carried into the Voxtral
 * path — `mimeToEncoding` runs before the provider router so a single
 * mapping survives both sides.)
 *
 * The transcription upstream doesn't accept MP4/AAC — Safari's
 * MediaRecorder default — so we return `null` for that surface and
 * the caller rejects at the MIME gate with a 400. Future Safari
 * voice support will need server-side transcoding (ffmpeg / batch
 * upload path); tracked under "Mobile MMP" in the root roadmap,
 * not actionable from this helper.
 *
 * Must stay in lockstep with the caller's ALLOWED_MIME allowlist: if
 * a MIME passes the allowlist but we return null here, the caller
 * has to surface a separate "unsupported encoding" error — an
 * inconsistency that'd confuse debugging.
 */
export function mimeToEncoding(mimeType: string): string | null {
  const m = mimeType.toLowerCase()
  if (m.startsWith('audio/webm')) return 'WEBM_OPUS'
  if (m.startsWith('audio/ogg')) return 'OGG_OPUS'
  if (m.startsWith('audio/wav') || m.startsWith('audio/x-wav')) return 'LINEAR16'
  return null
}
