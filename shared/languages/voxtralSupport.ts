/**
 * Voxtral (Mistral) supported transcription languages — ISO 639-1
 * codes. Source: Mistral model card for `voxtral-mini-transcribe-2507`
 * + `voxtral-mini-transcribe-realtime-2602`.
 *
 * Why this lives in `shared/`: both the dictation WS handler and the
 * voice-prompt transcribe endpoint enforce this set; the build-time
 * unit test in `tests/unit/voxtralSupport.test.ts` cross-checks every
 * shipped i18n locale against it so a future locale addition that's
 * NOT in this set fails CI rather than silently breaking dictation.
 *
 * To extend: ONLY add a code here after verifying it's actually
 * supported by the current Voxtral model. The unit test will then
 * accept new i18n locales that match. Do NOT add codes speculatively.
 */
export const VOXTRAL_SUPPORTED_LANGUAGES = [
  'en', // English
  'zh', // Chinese
  'hi', // Hindi
  'es', // Spanish
  'ar', // Arabic
  'fr', // French
  'pt', // Portuguese
  'ru', // Russian
  'de', // German
  'ja', // Japanese
  'ko', // Korean
  'it', // Italian
  'nl' // Dutch
] as const

export type VoxtralLanguage = typeof VOXTRAL_SUPPORTED_LANGUAGES[number]

/**
 * Predicate: does Voxtral support this language? Accepts either a
 * bare ISO 639-1 code (`en`, `de`) or a full BCP-47 tag (`en-US`,
 * `de-DE`) — only the leading segment matters for transcription.
 *
 * Returns false on empty / unparseable input rather than throwing,
 * so callers can use it as a defensive gate.
 */
export function isVoxtralSupportedLanguage(input: string | null | undefined): boolean {
  if (typeof input !== 'string' || input.length === 0) return false
  const lead = input.split('-')[0]?.toLowerCase()
  if (!lead) return false
  return (VOXTRAL_SUPPORTED_LANGUAGES as readonly string[]).includes(lead)
}
