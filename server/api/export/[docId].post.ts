export default defineEventHandler(async (event) => {
  // Rate limit: 10 exports per IP per minute
  const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || 'unknown'
  if (!(await checkRateLimit('export', ip, 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many export requests. Try again later.' })
  }

  const docId = requireDocId(event)

  const body = await readBody(event)
  const { markdown, format } = body as { markdown: string; format: 'pdf' | 'docx' | 'html' }

  if (!markdown) {
    throw createError({ statusCode: 400, message: 'Missing markdown content' })
  }

  const allowedFormats = new Set(['pdf', 'docx', 'html'])
  if (!format || !allowedFormats.has(format)) {
    throw createError({ statusCode: 400, message: `Invalid format: ${format}. Allowed: pdf, docx, html` })
  }

  const config = useRuntimeConfig()
  if (!config.pandocUrl) {
    throw createError({ statusCode: 503, message: 'Pandoc service not configured' })
  }

  const pandocUrl = `${config.pandocUrl}/convert?from=gfm&to=${format}&standalone`

  const response = await fetch(pandocUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Length': String(Buffer.byteLength(markdown))
    },
    body: markdown
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: 422,
      message: `Pandoc export failed: ${errorText.slice(0, 200)}`
    })
  }

  const contentTypes: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    html: 'text/html'
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  setResponseHeaders(event, {
    'Content-Type': contentTypes[format],
    'Content-Disposition': `attachment; filename="${docId}.${format}"`,
    'Content-Length': String(buffer.length)
  })

  return buffer
})
