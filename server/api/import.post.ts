const ALLOWED_EXTENSIONS = new Set(['docx', 'pdf', 'html', 'htm', 'tex', 'rst', 'odt', 'epub'])
const MAX_SIZE = 50 * 1024 * 1024 // 50 MB

export default defineEventHandler(async (event) => {
  // Rate limit: 10 imports per IP per minute
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!checkRateLimit('import', ip, 10, 60_000)) {
    throw createError({ statusCode: 429, message: 'Too many import requests. Try again later.' })
  }

  const formData = await readMultipartFormData(event)
  const file = formData?.find(f => f.name === 'file')

  if (!file || !file.data.length) {
    throw createError({ statusCode: 400, message: 'No file provided' })
  }
  if (file.data.length > MAX_SIZE) {
    throw createError({ statusCode: 413, message: 'File too large. Max 50MB.' })
  }

  const ext = file.filename?.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw createError({ statusCode: 415, message: `Unsupported format: .${ext}` })
  }

  const config = useRuntimeConfig()
  if (!config.pandocUrl) {
    throw createError({ statusCode: 503, message: 'Pandoc service not configured' })
  }

  // Call Pandoc HTTP service
  const pandocUrl = `${config.pandocUrl}/convert?from=${ext}&to=gfm`

  const response = await fetch(pandocUrl, {
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
      statusCode: 422,
      message: `Pandoc conversion failed: ${errorText.slice(0, 200)}`
    })
  }

  const markdown = await response.text()

  return {
    markdown,
    source: ext,
    filename: file.filename
  }
})
