import type { H3Event } from 'h3'
import { importMarkdownFile } from '../utils/documents/markdownImport'
import { capsFor, planLimitError, resolveUserPlan } from '../utils/billing/entitlements'
import { markitdownAuthHeaders } from '../utils/platform/markitdownAuth'
import { ID_RE } from '~~/shared/config/identifiers'
import { MIB } from '~~/shared/config/units'
import { IMPORT_MARKDOWN_MAX_BYTES, IMPORT_MAX_BYTES, IMPORT_REQUEST_MAX_BYTES } from '~~/shared/config/uploads'
import { MARKITDOWN_IMPORT_TIMEOUT_MS } from '../config/markitdown'

// Subset of formats markitdown handles well as document imports. It also
// supports CSV/JSON/XML/audio/images, but those round-trip into markdown
// poorly or need LLM/OCR config; keep the whitelist tight.
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
// Markdown needs no conversion: read as UTF-8 here, markoto's own
// frontmatter (theme + document properties, written by Download
// Markdown) is split off and validated (server/utils/documents/markdownImport.ts).
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
// A Markdown body lands in one Y.Doc (sync-server cap 16 MiB per document).

export default defineEventHandler(async (event) => {
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('import', ip, 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many import requests. Try again later.',
      data: { code: 'import/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  // The caller's plan sets the largest file it may convert
  // (`importMaxBytes`; anonymous = free), never above the platform cap.
  const session = await getValidatedUserSession(event)
  const plan = await resolveUserPlan(session?.user?.id ?? null)
  const planMaxBytes = Math.min(capsFor(plan).importMaxBytes, IMPORT_MAX_BYTES)

  // Size-bounded read. Bun (server/runtime/bunEntry.ts) and Traefik already
  // refuse over 51 MiB in production; this keeps the bound in every runtime.
  const body = await readBodyWithLimit(event, IMPORT_REQUEST_MAX_BYTES, 'import/file-too-large')
  const form = await parseMultipart(event, body)
  const file = form?.get('file')

  if (!file || typeof file === 'string' || file.size === 0) {
    throw createError({ statusCode: 400, message: 'No file provided', data: { code: 'import/no-file' } })
  }
  if (file.size > IMPORT_MAX_BYTES) {
    throw createError({
      statusCode: 413,
      message: 'File too large. Max 50MB.',
      data: { code: 'import/file-too-large' }
    })
  }
  if (file.size > planMaxBytes) {
    throw planLimitError(
      plan,
      'importMaxBytes',
      planMaxBytes,
      `File too large for your plan (max ${Math.floor(planMaxBytes / MIB)} MB).`
    )
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return await importMarkdown(event, file, form?.get('docId'))
  }

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

  // Markitdown's converter routing is extension-driven (StreamInfo in
  // markitdown-server/server.py), so pass the validated extension as a query
  // param instead of relying on Content-Type sniffing.
  const url = `${config.markitdownUrl}/convert?ext=${encodeURIComponent(ext)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(file.size),
        ...markitdownAuthHeaders()
      }),
      body: file,
      signal: AbortSignal.timeout(MARKITDOWN_IMPORT_TIMEOUT_MS)
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

async function importMarkdown(event: H3Event, file: File, rawDocId: FormDataEntryValue | null | undefined) {
  if (file.size > IMPORT_MARKDOWN_MAX_BYTES) {
    throw createError({
      statusCode: 413,
      message: 'Markdown file too large. Max 10MB.',
      data: { code: 'import/file-too-large' }
    })
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw createError({
      statusCode: 422,
      message: 'This Markdown file is not valid UTF-8 text.',
      data: { code: 'import/not-utf8' }
    })
  }
  // Without the target document the theme's images and custom CSS can't be
  // checked, so properties are only read when the editor names it (the import
  // only converts, it never writes to the document).
  const docId = typeof rawDocId === 'string' && ID_RE.test(rawDocId) ? rawDocId : null
  const result = docId
    ? importMarkdownFile(text, { docId, allowedOrigins: customCssAppOrigins(event) })
    : { markdown: text }
  return {
    ...result,
    source: 'md',
    filename: file.name
  }
}
