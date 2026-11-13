import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// User-only because the input field is `source_doc_id` (not the
// generic `doc_id` that buildDocBoundTool expects). The handler does
// its own authz check (canEditDoc on the source), no wrapper-level
// authz redundancy needed.
//
// `workspace_id` semantics: omit → inherit source's workspace.
// Empty string → personal (non-workspace) doc. Non-empty → explicit
// target (caller must be admin or editor of it). Modeled after the
// existing /api/docs/:id/duplicate endpoint's body shape.
export default buildUserOnlyTool({
  name: 'duplicate_document',
  description: 'Duplicate a document into a new docId owned by the authenticated user. Carries title, theme, content (Y.js state with image-URL rewrite), and S3 image assets. Returns { doc_id, url }. Use for "fork this template", "make a copy I can edit", etc.',
  scope: 'documents:write',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    source_doc_id: z.string().trim().min(1).describe('The doc id to duplicate. You must have edit access to it.'),
    title: z.string().trim().max(255).optional().describe('Title for the duplicate. Defaults to "Copy of {source title}" when omitted.'),
    workspace_id: z.string().optional().describe('Target workspace id to file the duplicate into. Omit to inherit the source\'s workspace; pass empty string to park as a personal doc; pass a workspace id you admin/edit to re-target.')
  }
})
