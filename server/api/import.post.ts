import type { H3Event } from 'h3'
import { importMarkdownFile, type MarkdownImportResult } from '../utils/documents/markdownImport'
import { capsFor, planLimitError, resolveUserPlan } from '../utils/billing/entitlements'
import { convertWithMarkitdown } from '../utils/imports/markitdownConvert'
import { attachImportImages } from '../utils/imports/importImages'
import { proveDocNeed } from '../utils/access/docProof'
import { ID_RE } from '~~/shared/config/identifiers'
import { MIB } from '~~/shared/config/units'
import { IMPORT_MARKDOWN_MAX_BYTES, IMPORT_MAX_BYTES, IMPORT_REQUEST_MAX_BYTES } from '~~/shared/config/uploads'

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
type ImportResponse = MarkdownImportResult & { source: ConvertedExtension | 'md', filename: string, imagesSkipped?: number }
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
  handler: async ({ event, user, self }): Promise<ImportResponse> => {
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

    // Inside a document the caller may write to, embedded pictures become
    // the document's images; anywhere else markitdown drops them.
    const docId = form?.get('docId')
    const target = user && typeof docId === 'string' && ID_RE.test(docId) ? await proveDocNeed(user.id, docId, 'write-content') : null
    if (!target || !self) {
      return { markdown: await convertWithMarkitdown(file, ext), source: ext, filename: file.name }
    }
    const converted = await convertWithMarkitdown(file, ext, { images: true })
    const { markdown, imagesSkipped } = await attachImportImages({
      doc: target,
      uploader: self,
      markdown: converted,
      readLinked: async () => null
    })
    return { markdown, source: ext, filename: file.name, ...(imagesSkipped > 0 ? { imagesSkipped } : {}) }
  }
})

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
