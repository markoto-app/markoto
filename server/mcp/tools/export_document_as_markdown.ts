import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Doc-bound — handler reads ctx.ytext + ctx.ymeta. Wrapper does
// view-access authz + YDocPool checkout to give the handler a synced
// doc. Returns the same file the editor's "Download Markdown" writes:
// markoto YAML frontmatter (shared/utils/markdown/markdownFrontmatter.ts) + the
// body without line-number prefixes.
//
// Distinct from view_document, which is for AI inspection (line
// numbers help the model reason about positions). This is the
// "give me the doc body" tool — for delivery / archival / piping.
export default buildDocBoundTool({
  name: 'export_document_as_markdown',
  description: 'Export a document as a markoto Markdown file — the same file the editor\'s "Download Markdown" writes: YAML frontmatter (markoto version, title, description, audience, language, templateId, theme) followed by the full body without line-number prefixes. Importing the file into markoto restores the theme and properties. Use to deliver the doc as a file, archive a snapshot, or feed it into another tool. For AI inspection, use view_document instead (it adds line numbers for position-aware editing).',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to export.')
  }
})
