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

export default defineEventHandler(async (event) => {
  // Rate limit: 10 imports per IP per minute
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!(await checkRateLimit('import', ip, 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many import requests. Try again later.',
      data: { code: 'import/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const formData = await readMultipartFormData(event)
  const file = formData?.find(f => f.name === 'file')

  if (!file || !file.data.length) {
    throw createError({ statusCode: 400, message: 'No file provided', data: { code: 'import/no-file' } })
  }
  if (file.data.length > MAX_SIZE) {
    throw createError({
      statusCode: 413,
      message: 'File too large. Max 50MB.',
      data: { code: 'import/file-too-large' }
    })
  }

  const ext = file.filename?.split('.').pop()?.toLowerCase() || ''
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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.data.length)
    },
    // `file.data` is a Node Buffer. At runtime undici's fetch accepts Buffer
    // directly; there is no type-clean path across @types/node, lib.dom, and
    // Bun's type overrides because `Buffer<ArrayBufferLike>` is not assignable
    // to `BodyInit` (which wants `ArrayBuffer`, not `SharedArrayBuffer`-
    // compatible backing). The cast is the pragmatic fix — no runtime copy,
    // imports can be up to 50 MB.
    body: file.data as unknown as BodyInit
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: response.status === 415 ? 415 : 422,
      message: `Conversion failed: ${errorText.slice(0, 200)}`
    })
  }

  const markdown = await response.text()

  return {
    markdown,
    source: ext,
    filename: file.filename
  }
})
