import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpDocSession } from './wrapDocBoundTool'
import { resolveSuggestions, type SuggestionAction } from '../../utils/suggestions/resolveSuggestions'
import { executeFunctionByName } from '../../utils/ai/tools/registry'
import { writeAccessOf } from '../../utils/agentic/toolContext'
import { readSuggestions } from '~~/shared/utils/suggestions/ySuggestions'
import { suggestionAuthorKey, suggestionKind } from '~~/shared/utils/suggestions/record'
import { mcpClientUserId } from '~~/shared/contracts/jwt'

// The suggestion tools of the MCP server (MCP-only: the in-app AI suggests
// through its normal edit tools in suggestion mode and never decides).
// Permissions follow the editor: anyone with view access lists, members
// who may edit suggest, and only those who edit directly (not limited to
// suggesting by the document) accept or reject.

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError })

export function listSuggestions({ handle }: McpDocSession): CallToolResult {
  const live = handle.ctx.ytext.toString()
  const list = readSuggestions(handle.ctx.ydoc).map(s => ({
    id: s.record.id,
    kind: s.obsolete ? 'obsolete' : suggestionKind(s.record, s.to - s.from),
    author: s.record.authorPrincipal === null ? s.record.authorName : 'AI',
    author_key: suggestionAuthorKey(s.record),
    from: s.from,
    to: s.to,
    struck_text: live.slice(s.from, s.to),
    inserted_text: s.record.text,
    changed_since: s.changed,
    created_at: new Date(s.record.createdAt).toISOString()
  }))
  return text(JSON.stringify({ suggestions: list }, null, 2))
}

export async function suggestEdit({ handle, mcpSessionId }: McpDocSession, oldStr: string, newStr: string): Promise<CallToolResult> {
  // replace_text's matching and messages, written as suggestions.
  handle.ctx.suggestSink = { principal: mcpClientUserId(mcpSessionId), name: 'MCP', forced: false, written: 0 }
  const r = await executeFunctionByName(handle.ctx, 'replace_text', { old_str: oldStr, new_str: newStr })
  return text(r.content, r.isError)
}

export async function decideSuggestions(session: McpDocSession, action: SuggestionAction, select: { ids?: string[], authorKey?: string }): Promise<CallToolResult> {
  if (session.mustSuggest) {
    return text('This document asks you to suggest changes; only people who edit it directly can accept or reject suggestions.', true)
  }
  const result = await resolveSuggestions({
    doc: writeAccessOf(session.handle.ctx),
    reviewer: { userId: session.handle.ctx.initiatorUserId, name: session.userName },
    action,
    select
  })
  const verb = action === 'accept' ? 'Accepted' : 'Rejected'
  return text(`${verb} ${result.resolved} suggestion${result.resolved === 1 ? '' : 's'}.${result.missing > 0 ? ` ${result.missing} no longer existed.` : ''}`)
}
