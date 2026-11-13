import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Mirrors the in-app loop's `search_activity_log` filter shape. Doc-bound
// every activity row belongs to a single doc, so the query needs a
// docId to scope on.
export default buildDocBoundTool({
  name: 'search_activity_log',
  description: 'Query the per-doc activity feed (edits, comments, theme/title changes, AI tool calls, restores) by action / actor / time / text query.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id whose activity to search.'),
    actions: z.array(z.string()).optional().describe('Filter to specific action types (e.g. ["edit", "comment.added"]). Omit to include all.'),
    actor_user_id: z.number().int().optional().describe('Filter to a specific user\'s actions.'),
    query: z.string().min(1).max(200).optional().describe('Text substring match against bodies / titles / similar.'),
    since: z.string().optional().describe('ISO 8601 timestamp, return rows on or after this instant.'),
    until: z.string().optional().describe('ISO 8601 timestamp, return rows before this instant.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max rows to return (default 25).')
  }
})
