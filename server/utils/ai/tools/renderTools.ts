import { z } from 'zod'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { renderDocument } from '../../rendering/renderClient'
import { useS3Client } from '../../storage/s3'
import { useEnv } from '~~/shared/env/load'

// view_pages / get_page_count: backend rendering pair. The user sees a paginated document (paged.js
// breaks the content into A4/Letter pages with @page rules); the AI only
// sees raw markdown which has no concept of "page". When the user says
// "fix the table on page 3" or "is page 1 too dense?" the AI needs to
// actually SEE the rendered output, not just read the markdown.
//
// `get_page_count` returns just the total. Cheap when the doc is already
// rendered; triggers a fresh render otherwise (~5-15s).
//
// `view_pages([n, m, …])` returns up to 5 PNGs of specific pages as
// `inlineData` parts on the next user turn (same smuggle-via-extraParts
// pattern as `view_image`). Costs more interactions because the
// vision model charges per-image input.

const GetPageCountArgs = z.object({}).strict()
  .describe('Return the total number of paginated pages in the current document (using the current theme\'s @page rules). Use when the user references a specific page number ("look at page 3") so you know if that page exists, before calling view_pages. Triggers a backend render if the doc hasn\'t been rendered yet.')

const ViewPagesArgs = z.object({
  pages: z.array(z.number().int().min(1).max(50)).min(1).max(5)
    .describe('1-indexed list of page numbers to fetch. Maximum 5 pages per call. Page numbers must be within the doc\'s rendered page count (use get_page_count first if you don\'t know it).')
}).strict()
  .describe('Fetch rendered PNG images of specific pages from the current document and inline them into the conversation so you can VISUALLY inspect what those pages look like. Use when the user references a specific page ("issue on page 3", "is page 1 too dense?", "fix the table layout on page 5") — the markdown gives you the content but not the page boundaries paged.js produces. Each page costs interactions; never call this preemptively, only when the user names a specific page.')

// Backend-rendered PNGs of paginated pages. The renderer container produces
// these on demand and uploads to S3 keyed by yjs-doc snapshot id; subsequent
// calls hit the cache. Each page image is billed as vision input tokens.
//
// Cap: 5 pages per call (enforced by Zod). The model is instructed to call
// these tools only when the user references a specific page, so images
// aren't rendered speculatively.

async function handleGetPageCount(
  session: MetaToolContext,
  _input: z.output<typeof GetPageCountArgs>
): Promise<ToolResult> {
  // No app-side charging: the renderer call is server-internal, so the
  // user only pays (via LiteLLM) for the chat turn that issued this call.
  session.updateStatus('tool', 'Counting pages…')

  try {
    if (!session.docAccess) return toolError('Error: rendering needs a document.')
    const result = await renderDocument(session.docAccess, { format: 'png' })
    return toolOk(`Document has ${result.manifest.pageCount} page(s) under the current theme. Use view_pages to inspect specific pages by 1-indexed number.`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return toolError(`Error: failed to render document for page count: ${msg}`)
  }
}

async function fetchPagePng(s3: ReturnType<typeof useS3Client>, bucket: string, key: string): Promise<Uint8Array> {
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!got.Body) throw new Error(`rendered page ${key} has no body`)
  return got.Body.transformToByteArray()
}

async function handleViewPages(
  session: MetaToolContext,
  input: z.output<typeof ViewPagesArgs>
): Promise<ToolResult> {
  const requestedPages = Array.from(new Set(input.pages)).sort((a, b) => a - b)

  // No app-side charging: the page images are injected into the next
  // user turn as `image_url` parts; the per-image input-token cost is
  // billed by LiteLLM on that turn's chat completion.
  session.updateStatus('tool', `Rendering ${requestedPages.length} page${requestedPages.length === 1 ? '' : 's'}…`)

  const docAccess = session.docAccess
  if (!docAccess) return toolError('Error: rendering needs a document.')
  let manifest
  try {
    const result = await renderDocument(docAccess, { format: 'png' })
    manifest = result.manifest
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return toolError(`Error: failed to render document: ${msg}`)
  }

  // Validate requested pages exist in the rendered output. A user asking
  // "look at page 12" on a 3-page doc gets a clear rejection, not silent
  // empty results.
  const outOfRange = requestedPages.filter(n => n < 1 || n > manifest.pageCount)
  if (outOfRange.length > 0) {
    return toolError(`Error: requested page(s) ${outOfRange.join(', ')} are out of range. The document has ${manifest.pageCount} page(s).`)
  }

  const env = useEnv()
  const s3 = useS3Client()
  const parts: { inlineData: { mimeType: string, data: string } }[] = []
  const captions: string[] = []

  for (const n of requestedPages) {
    // The render folder is the snapshot id plus, for documents with brand
    // inputs, the brand fingerprint — take the key the renderer reported
    // (matched by file name rather than trusting array order).
    const key = manifest.pageKeys.find(k => k.endsWith(`/page-${n}.png`))
    if (!key) return toolError(`Error: failed to fetch page ${n}: not in the render`)
    try {
      const bytes = await fetchPagePng(s3, env.storage.bucket, key)
      parts.push({ inlineData: { mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') } })
      captions.push(`page ${n} (${Math.round(bytes.byteLength / 1024)}KB)`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error'
      return toolError(`Error: failed to fetch page ${n}: ${msg}`)
    }
  }

  return {
    content: `Fetched ${parts.length} page image(s): ${captions.join(', ')}. The PNGs follow as inline image parts — inspect them visually to answer the user's question.`,
    isError: false,
    extraParts: parts
  }
}

export const getPageCountTool = defineMetaTool({
  name: 'get_page_count',
  description: 'Return how many paginated pages the document currently has under its theme\'s @page rules. The markdown source has no inherent page count — page boundaries only exist after paged.js paginates. Use this before view_pages when you don\'t already know the total, especially when the user references a page number ("look at page 3", "is page 5 the last one?"). Cheap on cache hit, ~5-15s on cache miss (full backend render).',
  schema: GetPageCountArgs,
  handler: handleGetPageCount
})

export const viewPagesTool = defineMetaTool({
  name: 'view_pages',
  description: 'Fetch rendered PNG screenshots of specific pages and add them to the conversation so you can SEE the typography, spacing, table layout, image placement, page-break decisions — anything that\'s visible after pagination but invisible in the markdown source. Use when the user names a specific page ("the table on page 3 is broken", "page 7 looks too sparse"). Pass a 1-indexed array of page numbers (1-5 pages per call). Each page is a real interaction-billed image input — don\'t call preemptively or "to check"; only when the user is asking about layout / visual issues on identified pages.',
  schema: ViewPagesArgs,
  requires: 'vision',
  // 3 calls × 5 pages each = 15 page-images, enough to inspect any
  // document. More than 3 means the model is stuck.
  sessionCallCap: 3,
  handler: handleViewPages
})
