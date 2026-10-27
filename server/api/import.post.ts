// Subset of formats markitdown handles well as document imports. Markitdown
// also supports CSV/JSON/XML/audio/images, but those don't make sense as a
// "drop a doc in to seed your markdown" path — they round-trip into markdown
// poorly or need extra LLM/OCR config. Keep the whitelist tight; widen later
// if users ask.
const ALLOWED_EXTENSIONS = new Set([
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'xls',
  'html',
  'htm',
  'epub'
])
const MAX_SIZE = 50 * 1024 * 1024 // 50 MB — kept in sync with markitdown-server/server.py
// Whole request: the file plus multipart framing. Traefik's buffering
// middleware on /api/import (prod + self-host compose) uses the same cap.
const MAX_BODY = MAX_SIZE + 1024 * 1024
// markitdown gives up after 60 s (MARKITDOWN_TIMEOUT_SECONDS); a little
// headroom so its own 504 arrives rather than our abort.
const MARKITDOWN_TIMEOUT_MS = 75_000

export default defineEventHandler(async (event) => {
  // Rate limit: 10 imports per IP per minute
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('import', ip, 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many import requests. Try again later.',
      data: { code: 'import/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  // Size-bounded read. In production Bun already refused anything over
  // 51 MiB (server/runtime/bunEntry.ts) and Traefik did on this route;
  // this keeps the same bound in every runtime.
  const body = await readBodyWithLimit(event, MAX_BODY, 'import/file-too-large')
  const form = await parseMultipart(event, body)
  const file = form?.get('file')

  if (!file || typeof file === 'string' || file.size === 0) {
    throw createError({ statusCode: 400, message: 'No file provided', data: { code: 'import/no-file' } })
  }
  if (file.size > MAX_SIZE) {
    throw createError({
      statusCode: 413,
      message: 'File too large. Max 50MB.',
      data: { code: 'import/file-too-large' }
    })
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw createError({
      statusCode: 415,
      message: `Unsupported format: .${ext}`,
      data: { code: 'import/unsupported-format' }
    })
  }

  const config = useRuntimeConfig()
  if (!config.markitdownUrl) {
    throw createError({ statusCode: 503, message: 'Markitdown service not configured' })
  }

  // Markitdown's converter routing is extension-driven (see StreamInfo in
  // markitdown-server/server.py), so we pass the validated extension as a
  // query param rather than relying on Content-Type sniffing.
  const url = `${config.markitdownUrl}/convert?ext=${encodeURIComponent(ext)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(file.size)
      }),
      body: file,
      signal: AbortSignal.timeout(MARKITDOWN_TIMEOUT_MS)
    })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    throw createError({
      statusCode: timedOut ? 504 : 502,
      message: timedOut ? 'Conversion took too long.' : 'The conversion service could not be reached.',
      data: { code: timedOut ? 'import/timeout' : 'import/unavailable' }
    })
  }

  if (!response.ok) {
    const errorText = await response.text()
    // markitdown answers 413 when an archive would expand past its limits
    // (zip-bomb guard) or the conversion hit its memory cap, 504 on its
    // own timeout.
    if (response.status === 413) {
      throw createError({
        statusCode: 413,
        message: 'This file is too large or too complex to convert.',
        data: { code: 'import/too-complex' }
      })
    }
    if (response.status === 504) {
      throw createError({ statusCode: 504, message: 'Conversion took too long.', data: { code: 'import/timeout' } })
    }
    throw createError({
      statusCode: response.status === 415 ? 415 : 422,
      message: `Conversion failed: ${errorText.slice(0, 200)}`
    })
  }

  const markdown = await response.text()

  return {
    markdown,
    source: ext,
    filename: file.name
  }
})
