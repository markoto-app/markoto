import { z } from 'zod'
import { DOWNLOAD_DISABLED_MESSAGE, userMayDownload } from '../../utils/documents/shareSettings'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { defineMcpTool, type McpRequestExtra, type McpToolCallback } from '@nuxtjs/mcp-toolkit/server'
import { renderDocument } from '../../utils/rendering/renderClient'
import { useS3Client } from '../../utils/storage/s3'
import { getDocAuthz } from '../../utils/workspaces/workspaceAccess'
import { toolEnabled } from '../lib/mcpToolContext'
import { admitToolCall } from '../lib/wrapDocBoundTool'

// MCP-only tool. The in-app agentic loop has no use for a PDF blob —
// `view_pages` already gives the loop per-page PNGs for visual
// inspection, and the loop has no surface to deliver a binary file
// to the user. MCP clients (Claude Desktop, ChatGPT app store) DO
// have a native attachment surface, so the binary PDF is the right
// shape here.
//
// Return shape: a full `CallToolResult` with an `embedded resource`
// content block carrying the base64-encoded PDF bytes. The toolkit
// passes this through verbatim — clients render it as an in-chat
// file attachment the user can save.
//
// Cost: each cache miss kicks the Playwright renderer container
// (~5-15s). Cache hits are sub-second. Rate-limited via the same
// `pdf-download` namespace as the public endpoint to share
// budget across surfaces.
//
// Why this isn't in TOOL_HANDLERS: the loop doesn't need it (no
// delivery channel), and the return shape is genuinely different
// from every other tool (binary embedded resource, not text). Wiring
// it through the META dispatch would require extending ToolResult
// with a resource variant just for one MCP-only tool — not worth it.

const inputSchema = {
  doc_id: z.string().min(1).describe('The doc id to render as PDF.')
}

export default defineMcpTool({
  name: 'export_document_as_pdf',
  title: 'Export Document As Pdf',
  description: 'Render a document to PDF and return the bytes as an attached file. Each cache miss runs the Playwright sidecar (~5-15s); cache hits are sub-second. Use to deliver a polished snapshot to the user — for AI inspection of a specific page, use view_pages instead.',
  inputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  enabled: event => toolEnabled(event, 'documents:read', 'export_document_as_pdf'),
  handler: (async (args: ShapeOutput<typeof inputSchema>, _extra: McpRequestExtra): Promise<CallToolResult> => {
    const event = useEvent()
    // Scope re-check + per-user call limit + the render allowance shared
    // with `GET /api/docs/:id/pdf`.
    const auth = await admitToolCall(event, 'export_document_as_pdf', 'documents:read', 'render')
    const docId = String(args.doc_id ?? '')
    if (!docId) {
      throw createError({
        statusCode: 400,
        message: 'export_document_as_pdf: doc_id is required',
        data: { code: 'mcp/missing-doc-id' }
      })
    }

    // View access on the source. Same anti-enumeration 404-shape as
    // the rest of the doc-bound MCP tools.
    const authz = await getDocAuthz(auth.userId, docId)
    if (!authz.exists || !authz.canView) {
      throw createError({
        statusCode: 404,
        message: 'export_document_as_pdf: document not found',
        data: { code: 'mcp/doc-not-found' }
      })
    }

    // View only (WP9): a visitor (e.g. a guest) gets no PDF, as on GET /pdf.
    if (!(await userMayDownload(docId, auth.userId))) {
      return { content: [{ type: 'text', text: DOWNLOAD_DISABLED_MESSAGE }], isError: true }
    }

    let result
    try {
      result = await renderDocument(docId, { format: 'pdf' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'render failed'
      // Tool-level error (not 5xx) so the model sees `isError: true`
      // and can wrap up gracefully — same treatment as a missing
      // page in view_pages.
      return {
        content: [{ type: 'text', text: `PDF render failed: ${msg}` }],
        isError: true
      }
    }
    const pdfKey = result.manifest.pdfKey
    if (!pdfKey) {
      return {
        content: [{ type: 'text', text: 'PDF render succeeded but the manifest is missing pdfKey — internal inconsistency.' }],
        isError: true
      }
    }

    // Fetch the PDF bytes from S3 and inline as base64. The toolkit
    // doesn't proxy a presigned URL — MCP clients can't reliably
    // open authenticated URLs the way browsers can, so we deliver
    // the bytes directly. Typical PDF size is 50KB-2MB; well within
    // the JSON-RPC envelope ceiling.
    const config = useRuntimeConfig()
    const s3 = useS3Client()
    const obj = await s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: pdfKey
    }))
    if (!obj.Body) {
      return {
        content: [{ type: 'text', text: 'PDF render succeeded but S3 returned an empty body.' }],
        isError: true
      }
    }
    const bytes = await obj.Body.transformToByteArray()
    const base64 = Buffer.from(bytes).toString('base64')

    // Embedded resource. The URI uses a synthetic `doc:///` scheme
    // so MCP hosts can dedupe / cache by stable identity. The render
    // folder is the snapshot id (changes per content edit) plus the brand
    // fingerprint (changes with the workspace fonts / logos / locked
    // design), so the URI is content-addressed.
    return {
      content: [
        {
          type: 'text',
          text: `Rendered PDF for doc ${docId} (${result.manifest.pageCount} page${result.manifest.pageCount === 1 ? '' : 's'}, ${result.cached ? 'cached' : 'fresh render'}).`
        },
        {
          type: 'resource',
          resource: {
            uri: `doc:///${docId}/${renderFolderOf(pdfKey)}.pdf`,
            mimeType: 'application/pdf',
            blob: base64
          }
        }
      ],
      isError: false
    }
  }) as McpToolCallback<typeof inputSchema>
})

/** `renders/<docId>/<folder>/<file>.pdf` → `<folder>`. */
function renderFolderOf(pdfKey: string): string {
  return pdfKey.split('/').at(-2) ?? pdfKey
}
