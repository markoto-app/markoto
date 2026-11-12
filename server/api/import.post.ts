import type { H3Event } from 'h3'
import { importMarkdownFile, type MarkdownImportResult } from '../utils/documents/markdownImport'
import { capsFor, planLimitError, resolveUserPlan } from '../utils/billing/entitlements'
import { markitdownAuthHeaders } from '../utils/platform/markitdownAuth'
import { ID_RE } from '~~/shared/config/identifiers'
import { MIB } from '~~/shared/config/units'
import { IMPORT_MARKDOWN_MAX_BYTES, IMPORT_MAX_BYTES, IMPORT_REQUEST_MAX_BYTES } from '~~/shared/config/uploads'
import { MARKITDOWN_IMPORT_TIMEOUT_MS } from '../config/markitdown'
import { useEnv } from '~~/shared/env/load'

// Subset of formats markitdown handles well as document imports. It also
// supports CSV/JSON/XML/audio/images, but those round-trip into markdown
// poorly or need LLM/OCR config; keep the whitelist tight.
const CONVERTED_EXTENSIONS = ['docx', 'pdf', 'pptx', 'xlsx', 'xls', 'html', 'htm', 'epub'] as const
type ConvertedExtension = typeof CONVERTED_EXTENSIONS[number]
const isConvertedExtension = (ext: string): ext is ConvertedExtension => (CONVERTED_EXTENSIONS as readonly string[]).includes(ext)

/**
 * What an import answers. `source` is the file's format: only a Markdown
 * file (`md`) can carry markoto's frontmatter (`properties`, `ignored`,
 * `droppedCustomCssRules`); a converted file is markdown alone. One object
 * type rather than a union, so the optional fields stay readable on the
 * client without narrowing.
 */
type ImportResponse = MarkdownImportResult & { source: ConvertedExtension | 'md', filename: string }
// Markdown needs no conversion: read as UTF-8 here, markoto's own
// frontmatter (theme + document properties, written by Download
// Markdown) is split off and validated (server/utils/documents/markdownImport.ts).
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
// A Markdown body lands in one Y.Doc (sync-server cap 16 MiB per document).

// Public with an optional session (anonymous users import too); limited per client.
// The multipart body is read by the handler through a size-bounded reader
// BEFORE it is parsed, so the wrapper must not read it first (`body: 'multipart'`).
export default defineApiHandler({
  access: allow.public('Importing converts a file and stores nothing; open to anonymous visitors, limited per client and by the caller\'s plan', { session: 'optional' }),
  body: 'multipart',
  // Before the optional session lookup: anonymous floods never reach the database.
  rateLimit: { namespace: 'import', max: 10, windowMs: 60_000, key: 'ip', phase: 'before-access', error: 'import/rate-limited' },
  handler: async ({ event, user }): Promise<ImportResponse> => {
    // The caller's plan sets the largest file it may convert
    // (`importMaxBytes`; anonymous = free), never above the platform cap.
    const plan = await resolveUserPlan(user?.id ?? null)
    const planMaxBytes = Math.min(capsFor(plan).importMaxBytes, IMPORT_MAX_BYTES)

    // Size-bounded read. Bun (server/runtime/bunEntry.ts) and Traefik already
    // refuse over 51 MiB in production; this keeps the bound in every runtime.
    const body = await readBodyWithLimit(event, IMPORT_REQUEST_MAX_BYTES, 'import/file-too-large')
    const form = await parseMultipart(event, body)
    const file = form?.get('file')

    if (!file || typeof file === 'string' || file.size === 0) throw apiError('import/no-file')
    if (file.size > IMPORT_MAX_BYTES) throw apiError('import/file-too-large')
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

    if (!isConvertedExtension(ext)) throw apiError('import/unsupported-format')

    const markdown = await convertWithMarkitdown(file, ext)

    return {
      markdown,
      source: ext,
      filename: file.name
    }
  }
})

/** A converted file's Markdown from the markitdown service; its failures map to the import error codes. */
async function convertWithMarkitdown(file: File, ext: ConvertedExtension): Promise<string> {
  const env = useEnv()
  if (!env.markitdown.url) throw apiError('import/not-configured')

  // Markitdown's converter routing is extension-driven (StreamInfo in
  // markitdown-server/server.py), so pass the validated extension as a query
  // param instead of relying on Content-Type sniffing.
  const url = `${env.markitdown.url}/convert?ext=${encodeURIComponent(ext)}`

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
    throw apiError(timedOut ? 'import/timeout' : 'import/unavailable')
  }

  if (!response.ok) {
    const errorText = await response.text()
    // markitdown answers 413 when an archive would expand past its limits
    // (zip-bomb guard) or the conversion hit its memory cap, 504 on its
    // own timeout.
    if (response.status === 413) throw apiError('import/too-complex')
    if (response.status === 504) throw apiError('import/timeout')
    throw apiError('import/conversion-failed', { detail: errorText.slice(0, 200) }, { status: response.status === 415 ? 415 : 422 })
  }

  return await response.text()
}

async function importMarkdown(event: H3Event, file: File, rawDocId: FormDataEntryValue | null | undefined): Promise<ImportResponse> {
  if (file.size > IMPORT_MARKDOWN_MAX_BYTES) throw apiError('import/file-too-large')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw apiError('import/not-utf8')
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
