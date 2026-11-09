import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { TEMPLATE_IDS, TEMPLATE_TOOL_HINT } from '~~/shared/templates'
import { AUDIENCE_KINDS } from '~~/shared/audiences'

// User-only — `create_document` doesn't operate on an existing doc;
// it mints a NEW one owned by the caller. Routed through
// META_TOOL_HANDLERS → handleCreateDocument which calls the shared
// `createDocument` helper (same code path as POST /api/docs).
//
// Optional initial_markdown seeds the doc body in one call so the
// caller doesn't have to follow up with insert_text. Workspace
// authorization (admin/editor required) is enforced inside the
// helper; viewers + non-members get a 403-shape tool error.
export default buildUserOnlyTool({
  name: 'create_document',
  description: 'Create a NEW document owned by the authenticated user. Returns { doc_id, url }. Optional initial_markdown seeds the body in one call (skip the follow-up insert_text). Optional workspace_id files into a workspace (you must be admin or editor).',
  scope: 'documents:write',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    title: z.string().trim().max(255).optional().describe('Doc title (≤255 chars). Empty / omitted falls back to "Untitled".'),
    initial_markdown: z.string().max(100_000).optional().describe('Optional initial body for the new doc (up to 100k chars). Saves a follow-up insert_text call.'),
    workspace_id: z.string().min(1).optional().describe('Optional workspace id to file into. Must be admin or editor of it. Omit for personal doc.'),
    description: z.string().max(500).optional().describe('Optional one-sentence summary, ≤500 chars.'),
    audience: z.enum(AUDIENCE_KINDS as [string, ...string[]]).optional().describe(`Audience for AI tone steering. One of: ${AUDIENCE_KINDS.join(', ')}.`),
    language: z.string().trim().min(1).max(50).optional().describe('Free-form language label ("English", "Deutsch").'),
    template_id: z.enum(TEMPLATE_IDS.length > 0 ? (TEMPLATE_IDS as [string, ...string[]]) : (['blank'] as [string, ...string[]])).optional().describe(`Template: a starting text plus its design. Seeds the doc body (when initial_markdown is not provided) and, without theme_preset / theme_id, sets the template's design. One of: ${TEMPLATE_TOOL_HINT}.`),
    theme_preset: z.string().min(1).optional().describe('Built-in theme preset id; overrides the template\'s design. Mutually exclusive with theme_id.'),
    theme_id: z.string().min(1).max(64).optional().describe('User-saved theme preset id (from list_themes). Mutually exclusive with theme_preset.')
  }
})
