import type { H3Event } from 'h3'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { admitToolCall, mcpSessionIdFromEvent } from './wrapDocBoundTool'
import { proveDocMembership, proveDocNeed } from '../../utils/access/docProof'
import { proveSelf } from '../../utils/access/userProof'
import { proveWorkspaceAccess } from '../../utils/access/workspaceAccess'
import { findUserName } from '../../repos/users'
import { connectAsMcpClient } from '../../utils/mcp/mcpHocuspocusClient'
import { mustSuggest } from '../../utils/suggestions/suggestionAccess'
import { resolveSuggestions, type SuggestionAction } from '../../utils/suggestions/resolveSuggestions'
import { executeFunctionByName } from '../../utils/ai/tools/registry'
import { readSuggestions } from '~~/shared/utils/suggestions/ySuggestions'
import { suggestionAuthorKey, suggestionKind } from '~~/shared/utils/suggestions/record'
import { mcpClientUserId } from '~~/shared/contracts/jwt'
import { apiError } from '../../utils/api/apiError'

// The suggestion tools of the MCP server (MCP-only: the in-app AI suggests
// through its normal edit tools in suggestion mode and never decides).
// Permissions follow the editor: anyone with view access lists, members
// who may edit suggest, and only those who edit directly (not limited to
// suggesting by the document) accept or reject.

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError })

async function openDoc(event: H3Event, userId: number, docId: string, kind: 'view' | 'edit') {
  const proven = await proveDocMembership(userId, docId, kind)
  if (!proven) throw apiError('mcp/doc-not-found')
  const self = proveSelf(userId)
  const mcpSessionId = mcpSessionIdFromEvent(event) ?? `oneshot-${Date.now()}`
  const handle = await connectAsMcpClient({
    docId,
    userId,
    mcpSessionId,
    userName: (await findUserName(self)) ?? `user-${userId}`,
    workspaceId: proven.workspaceId,
    docAccess: proven.access,
    self,
    workspaceAccess: proven.workspaceId ? await proveWorkspaceAccess(userId, proven.workspaceId, 'member') : null
  })
  return { handle, row: proven.row, self, mcpSessionId }
}

export async function listSuggestionsTool(docId: string): Promise<CallToolResult> {
  const event = useEvent()
  const auth = await admitToolCall(event, 'list_suggestions', 'documents:read')
  const { handle } = await openDoc(event, auth.userId, docId, 'view')
  try {
    const list = readSuggestions(handle.ctx.ydoc).map(s => ({
      id: s.record.id,
      kind: s.obsolete ? 'obsolete' : suggestionKind(s.record, s.to - s.from),
      author: s.record.authorPrincipal !== null ? 'AI' : s.record.authorName,
      author_key: suggestionAuthorKey(s.record),
      from: s.from,
      to: s.to,
      struck_text: handle.ctx.ytext.toString().slice(s.from, s.to),
      inserted_text: s.record.text,
      changed_since: s.changed,
      created_at: new Date(s.record.createdAt).toISOString()
    }))
    return text(JSON.stringify({ suggestions: list }, null, 2))
  } finally {
    handle.release()
  }
}

export async function suggestEditTool(docId: string, oldStr: string, newStr: string): Promise<CallToolResult> {
  const event = useEvent()
  const auth = await admitToolCall(event, 'suggest_edit', 'documents:write')
  const { handle, mcpSessionId } = await openDoc(event, auth.userId, docId, 'edit')
  try {
    // replace_text's matching and messages, written as suggestions.
    handle.ctx.suggestSink = { principal: mcpClientUserId(mcpSessionId), name: 'MCP', forced: false, written: 0 }
    const r = await executeFunctionByName(handle.ctx, 'replace_text', { old_str: oldStr, new_str: newStr })
    return text(r.content, r.isError)
  } finally {
    handle.release()
  }
}

export async function resolveSuggestionsTool(action: SuggestionAction, docId: string, select: { ids?: string[], authorKey?: string }): Promise<CallToolResult> {
  const event = useEvent()
  const auth = await admitToolCall(event, action === 'accept' ? 'accept_suggestions' : 'reject_suggestions', 'documents:write')
  const access = await proveDocNeed(auth.userId, docId, 'write-content')
  const member = await proveDocMembership(auth.userId, docId, 'edit')
  if (!access || !member) throw apiError('mcp/doc-not-found')
  if (mustSuggest(member.row, auth.userId)) {
    return text('This document asks you to suggest changes; only people who edit it directly can accept or reject suggestions.', true)
  }
  const name = (await findUserName(proveSelf(auth.userId))) ?? `user-${auth.userId}`
  const result = await resolveSuggestions({ doc: access, reviewer: { userId: auth.userId, name }, action, select })
  const verb = action === 'accept' ? 'Accepted' : 'Rejected'
  return text(`${verb} ${result.resolved} suggestion${result.resolved === 1 ? '' : 's'}.${result.missing > 0 ? ` ${result.missing} no longer existed.` : ''}`)
}
