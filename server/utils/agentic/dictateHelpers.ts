// Pure helpers for the dictation WebSocket route. Lifted out of the
// main handler file so unit tests can import them without pulling in
// the `@google-cloud/speech` gRPC stack (and the ~15 MB protobuf
// baggage that implies). The handler re-exports from here.

/**
 * Parse a crossws Message as one of our known control frames. Returns
 * the parsed control object on success or `null` if the frame is NOT
 * a control frame (i.e. it's audio or junk).
 *
 * Implementation note: crossws + the Node `ws` library deliver text
 * frames as Buffer, so `typeof rawData === 'string'` is unreliable.
 * We peek the first byte for `{` (0x7B) — our control frames are
 * always JSON objects — and only decode+parse when that matches. For
 * binary audio (int16 PCM, random first bytes), the peek short-
 * circuits without paying for a full TextDecoder + JSON.parse on
 * every 4 KiB chunk (~8 chunks/second at 16 kHz).
 *
 * We whitelist control `type` values so a random PCM chunk that does
 * coincidentally start with `{` AND parses as JSON (unlikely but
 * possible with small buffers) won't be routed as a control frame.
 */
export function tryParseControl(message: { rawData: unknown, text(): string }): {
  type: 'auth' | 'stop'
  token?: unknown
  languageCode?: unknown
} | null {
  const raw = message.rawData
  if (typeof raw !== 'string') {
    const firstByte = Buffer.isBuffer(raw)
      ? raw[0]
      : raw instanceof Uint8Array
        ? raw[0]
        : undefined
    if (firstByte !== 0x7B /* '{' */) return null
  }
  let text: string
  try {
    text = message.text()
  } catch {
    return null
  }
  if (!text.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { type?: unknown, token?: unknown, languageCode?: unknown }
  if (obj.type === 'auth' || obj.type === 'stop') {
    return { type: obj.type, token: obj.token, languageCode: obj.languageCode }
  }
  return null
}

/**
 * Normalize a UI locale / user-supplied language hint to a BCP-47 tag
 * Cloud STT will accept. We store short ISO 639-1 codes (`en`, `de`,
 * …) for the UI; Cloud STT wants the regional form (`en-US`,
 * `de-DE`). Unknown codes fall back to `en-US` rather than erroring
 * so a typo in the cookie can't block transcription.
 *
 * BCP-47-shaped strings (contains a dash) pass through — a power
 * user who sets `de-CH` or `en-GB` gets the locale they asked for.
 */
export function normalizeLanguageCode(input: unknown): string {
  const s = typeof input === 'string' ? input.trim() : ''
  if (/^[a-z]{2,3}-[A-Z]{2,3}$/i.test(s)) return s
  switch (s.toLowerCase()) {
    case 'en': return 'en-US'
    case 'de': return 'de-DE'
    case 'fr': return 'fr-FR'
    case 'es': return 'es-ES'
    case 'ja': return 'ja-JP'
    case 'zh': return 'zh-CN'
    default: return 'en-US'
  }
}
