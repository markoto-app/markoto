import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { lineToCharOffset } from './documentText'
import type { DocToolContext } from '../../agentic/toolContext'
import { readYComment, type YCommentFields } from '~~/shared/utils/documents/yComment'
import { plainCommentText, stripAiMention } from '../../agentic/commentTriggerPrompt'
import { AI_COMMENT_AUTHOR_NAME, isAiCommentAuthor } from '~~/shared/ai/author'
import { canManageDoc } from '../../access/workspaceAccess'
import { TOOL_RESULT_CHAR_CAP } from '../../agentic/limits'

// Comments are the primary channel for AI <-> user communication; every comment
// appears in the sidebar in real time (same as collaborator comments).

const ReadCommentsArgs = z.object({})
  .describe('Read all comment threads on this document: IDs, anchored line ranges, resolved status, bodies, and replies. Call this before creating, replying to, resolving, or deleting any comment.')

const CreateCommentArgs = z.object({
  start_line: z.number().int().min(1)
    .describe('First line of the text range to anchor the comment to (1-indexed, inclusive).'),
  end_line: z.number().int().min(1)
    .describe('Last line of the text range (1-indexed, inclusive). Must be >= start_line.'),
  body: z.string().trim().min(1).max(4000)
    .describe('Comment body (max 4000 chars). Plain text, comments do not render Markdown, so no **bold**, # headings or list markup. May include @[Name](user:ID) mention tokens using IDs from <workspace_members>.')
}).describe('Place a new comment anchored to a line range. Use for review notes, questions, to-dos, or to communicate with the user about a specific part of the document. Your comment appears as "markoto".')

const ReplyToCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread to reply to (from read_comments).'),
  body: z.string().trim().min(1).max(2000)
    .describe('Reply body (max 2000 chars). Plain text, comments do not render Markdown, so no **bold**, # headings or list markup. May include @[Name](user:ID) mention tokens.')
}).describe('Add a reply to an existing comment thread. Your reply appears as "markoto" nested under the thread.')

const ResolveCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread to resolve or reopen (from read_comments).'),
  resolved: z.boolean()
    .describe('true to mark the thread resolved, false to reopen it.')
}).describe('Resolve or reopen a comment thread. Resolved threads are hidden by default in the UI but not deleted.')

const DeleteCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread (from read_comments).'),
  reply_id: z.string().min(1).max(64).optional()
    .describe('If provided, delete only this specific reply. If omitted, delete the whole thread.')
}).describe('Delete a comment thread or a single reply within a thread. Can only delete comments/replies authored by AI Assistant or by the user who triggered this session, unless that user has document management rights.')

// Comments live in a top-level `Y.Array<Y.Map>` named "comments" in the Y.Doc.
// Each comment map has: id, anchorStart, anchorEnd (base64 Y.RelativePositions),
// body, authorId (null for AI), authorName, authorAvatarSeed (anonymous authors
// only), createdAt, updatedAt,
// resolved, replies (nested Y.Array<Y.Map>).
//
// Anchors are encoded as base64 strings via Buffer (not btoa, server context).

function _toBase64Comment(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function _fromBase64Comment(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Resolve a comment's anchor to { from, to } char offsets, or null (orphan). */
function resolveCommentAnchor(
  comment: YCommentFields,
  ydoc: Y.Doc
): { from: number, to: number } | null {
  const startB64 = comment.anchorStart
  const endB64 = comment.anchorEnd
  if (startB64 === null || endB64 === null) return null
  try {
    const startRel = Y.decodeRelativePosition(_fromBase64Comment(startB64))
    const endRel = Y.decodeRelativePosition(_fromBase64Comment(endB64))
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
    if (!startAbs || !endAbs || startAbs.index >= endAbs.index) return null
    return { from: startAbs.index, to: endAbs.index }
  } catch {
    return null
  }
}

/** Strip mention tokens to bare @Name for model-readable display. */
function stripMentions(body: string): string {
  return body.replace(/@\[([^\]]+)\]\(user:\d+\)/g, '@$1')
}

/** Format epoch-ms as a human-readable date string. */
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const COMMENT_ANCHOR_PREVIEW_MAX = 150

/** Room the read_comments result gets, below the loop's result cap. */
const READ_COMMENTS_CHAR_BUDGET = TOOL_RESULT_CHAR_CAP - 2_000
/** Room kept for the one-line list of threads that do not fit in full (about 80 lines). */
const COMMENT_SUMMARY_RESERVE = 5_000

/** Build a human-readable anchor label from a resolved Y.js anchor. */
function formatAnchorLabel(
  anchor: { from: number, to: number } | null,
  fullText: string
): string {
  if (!anchor) return '[orphaned, anchored text was deleted]'
  const anchorText = fullText.slice(anchor.from, anchor.to)
  const preview = anchorText.length > COMMENT_ANCHOR_PREVIEW_MAX
    ? anchorText.slice(0, COMMENT_ANCHOR_PREVIEW_MAX) + '…'
    : anchorText
  // Convert char offsets to approximate line numbers for the model.
  const startLine = fullText.slice(0, anchor.from).split('\n').length
  const endLine = fullText.slice(0, anchor.to).split('\n').length
  return startLine === endLine
    ? `line ${startLine}: "${preview}"`
    : `lines ${startLine}–${endLine}: "${preview}"`
}

/** Format the four header lines (---, anchor, by, comment) for one thread. */
function formatThreadHeader(map: Y.Map<unknown>, fullText: string, ydoc: Y.Doc): string[] {
  const c = readYComment(map)
  const anchorLabel = formatAnchorLabel(resolveCommentAnchor(c, ydoc), fullText)
  return [
    `--- Thread ${c.id ?? ''}${c.resolved ? ' [RESOLVED]' : ''} ---`,
    `Anchor: ${anchorLabel}`,
    `By: ${c.authorName ?? 'Unknown'} at ${fmtDate(c.createdAt)}`,
    `Comment: ${stripMentions(c.body)}`
  ]
}

/** Format the optional replies block (header + indented per-reply lines). */
function formatThreadReplies(map: Y.Map<unknown>): string[] {
  const repliesArr = map.get('replies')
  if (!(repliesArr instanceof Y.Array) || repliesArr.length === 0) return []
  const lines = [`Replies (${repliesArr.length}):`]
  for (let j = 0; j < repliesArr.length; j++) {
    const r = repliesArr.get(j)
    if (!(r instanceof Y.Map)) continue
    const reply = readYComment(r)
    lines.push(`  [${reply.id ?? ''}] ${reply.authorName ?? 'Unknown'} at ${fmtDate(reply.createdAt)}: ${stripMentions(reply.body)}`)
  }
  return lines
}

function handleReadComments(
  session: DocToolContext,
  _input: z.output<typeof ReadCommentsArgs>
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  if (ycomments.length === 0) return toolOk('No comments on this document.')

  const fullText = session.ytext.toJSON()
  const header = `Found ${ycomments.length} comment thread(s):\n`
  const maps: Array<Y.Map<unknown>> = []
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (map instanceof Y.Map) maps.push(map)
  }
  const threads = maps.map(map => [...formatThreadHeader(map, fullText, session.ydoc), ...formatThreadReplies(map), ''].join('\n'))
  const total = threads.reduce((n, t) => n + t.length + 1, header.length)
  if (total <= READ_COMMENTS_CHAR_BUDGET) return toolOk([header, ...threads].join('\n'))

  // Too many for one result: threads in full while they fit (leaving room
  // for the list), the rest one line each, so every id stays reachable for
  // reply / resolve / delete.
  const lines = [header]
  let size = header.length
  let fullCount = 0
  for (const thread of threads) {
    if (size + thread.length > READ_COMMENTS_CHAR_BUDGET - COMMENT_SUMMARY_RESERVE) break
    lines.push(thread)
    size += thread.length + 1
    fullCount += 1
  }
  const summaries = maps.slice(fullCount).map(map => formatThreadSummary(map, fullText, session.ydoc))
  lines.push(...summaryBlock(summaries, READ_COMMENTS_CHAR_BUDGET - size))
  return toolOk(lines.join('\n'))
}

/** The one-line-per-thread list, cut at a line to fit `room` characters. */
function summaryBlock(summaries: readonly string[], room: number): string[] {
  let listed = summaries.join('\n')
  if (listed.length > room) {
    const cut = listed.lastIndexOf('\n', Math.max(0, room))
    listed = cut > 0 ? listed.slice(0, cut) : ''
  }
  const unlisted = summaries.length - (listed ? listed.split('\n').length : 0)
  return [
    `${summaries.length} more thread(s) did not fit in full (result size limit). Their ids, anchors and authors:`,
    ...(listed ? [listed] : []),
    ...(unlisted > 0 ? [`(${unlisted} further thread(s) not listed.)`] : [])
  ]
}

/** One line per thread for the part of read_comments that does not fit in full. */
function formatThreadSummary(map: Y.Map<unknown>, fullText: string, ydoc: Y.Doc): string {
  const c = readYComment(map)
  const anchor = resolveCommentAnchor(c, ydoc)
  const where = anchor
    ? `lines ${fullText.slice(0, anchor.from).split('\n').length}-${fullText.slice(0, anchor.to).split('\n').length}`
    : 'orphaned'
  const replies = map.get('replies')
  const replyCount = replies instanceof Y.Array ? replies.length : 0
  return `- Thread ${c.id ?? ''}${c.resolved ? ' [RESOLVED]' : ''}, ${where}, by ${c.authorName ?? 'Unknown'}, ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`
}

async function handleCreateComment(
  session: DocToolContext,
  input: z.output<typeof CreateCommentArgs>
): Promise<ToolResult> {
  if (input.end_line < input.start_line) {
    return toolError('Error: end_line must be >= start_line.')
  }

  const full = session.ytext.toJSON()
  const startChar = lineToCharOffset(full, input.start_line - 1)
  if (startChar === null) {
    return toolError(`Error: start_line ${input.start_line} is beyond the end of the document.`)
  }
  // end_line offset: start of the line AFTER end_line. Clamped to full.length
  // when end_line is the last line (lineToCharOffset returns null in that case).
  const rawEnd = lineToCharOffset(full, input.end_line)
  const endChar = rawEnd ?? full.length

  if (startChar >= endChar) {
    return toolError('Error: the specified line range resolves to an empty anchor. Use a range that covers at least one character.')
  }

  session.updateStatus('editing', aiStatus('addComment'))

  const startRel = Y.createRelativePositionFromTypeIndex(session.ytext, startChar, 0)
  const endRel = Y.createRelativePositionFromTypeIndex(session.ytext, endChar, -1)
  const anchorStart = _toBase64Comment(Y.encodeRelativePosition(startRel))
  const anchorEnd = _toBase64Comment(Y.encodeRelativePosition(endRel))

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip any `@ai` tokens the model may have written into its body,
  // otherwise its own comment would re-trigger the @ai-mention path the
  // next time the doc is loaded by a client. Belt-and-suspenders: the
  // server-side trigger guard ALSO rejects AI-authored messages, but
  // stripping here keeps the badge from rendering misleadingly in the UI.
  const safeBody = plainCommentText(stripAiMention(input.body))

  session.ydoc.transact(() => {
    const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    map.set('id', id)
    map.set('anchorStart', anchorStart)
    map.set('anchorEnd', anchorEnd)
    map.set('body', safeBody)
    map.set('authorId', null)
    map.set('authorName', AI_COMMENT_AUTHOR_NAME)
    map.set('authorAvatarSeed', null)
    map.set('createdAt', now)
    map.set('updatedAt', now)
    map.set('resolved', false)
    map.set('replies', new Y.Array())
    ycomments.push([map])
  }, origin)

  return toolOk(`Comment ${id} created on lines ${input.start_line}–${input.end_line}.`)
}

function handleReplyToComment(
  session: DocToolContext,
  input: z.output<typeof ReplyToCommentArgs>
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  let parentMap: Y.Map<unknown> | null = null
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      parentMap = m
      break
    }
  }
  if (!parentMap) {
    return toolError(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
  }

  const repliesArrRaw = parentMap.get('replies')
  if (!(repliesArrRaw instanceof Y.Array)) {
    return toolError(`Error: comment "${input.comment_id}" has a malformed replies array.`)
  }
  const repliesArr: Y.Array<Y.Map<unknown>> = repliesArrRaw
  const parent = parentMap

  session.updateStatus('editing', aiStatus('replyCommentAny'))

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip @ai from the reply body, same rationale as create_comment.
  const safeBody = plainCommentText(stripAiMention(input.body))

  session.ydoc.transact(() => {
    const reply = new Y.Map<unknown>()
    reply.set('id', id)
    reply.set('body', safeBody)
    reply.set('authorId', null)
    reply.set('authorName', AI_COMMENT_AUTHOR_NAME)
    reply.set('authorAvatarSeed', null)
    reply.set('createdAt', now)
    reply.set('updatedAt', now)
    repliesArr.push([reply])
    parent.set('updatedAt', now)
  }, origin)

  return toolOk(`Reply ${id} added to thread ${input.comment_id}.`)
}

function handleResolveComment(
  session: DocToolContext,
  input: z.output<typeof ResolveCommentArgs>
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      const origin = `ai:assistant:${session.sessionId}`
      session.ydoc.transact(() => {
        m.set('resolved', input.resolved)
        m.set('updatedAt', Date.now())
      }, origin)
      return toolOk(`Thread ${input.comment_id} marked as ${input.resolved ? 'resolved' : 'open'}.`)
    }
  }
  return toolError(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}

async function handleDeleteComment(
  session: DocToolContext,
  input: z.output<typeof DeleteCommentArgs>
): Promise<ToolResult> {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')

  // Determine if the initiator has doc management rights (cached once per call).
  let _canManage: boolean | null = null
  async function initiatorCanManage(): Promise<boolean> {
    _canManage ??= await canManageDoc(session.initiatorUserId, session.docId)
    return _canManage
  }

  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (!(m instanceof Y.Map) || m.get('id') !== input.comment_id) continue
    return input.reply_id
      ? deleteReplyFromThread(session, m, input.comment_id, input.reply_id, initiatorCanManage)
      : deleteWholeThread(session, ycomments, i, m, input.comment_id, initiatorCanManage)
  }
  return toolError(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}

/**
 * Authorship gate for comment/reply deletion. markoto's own posts
 * (authorId=null + authorName='markoto', plus the older 'AI Assistant'
 * name) and the initiator's own posts are always
 * deletable. Anything else falls through to the doc-manage right.
 */
function canDeleteEntry(map: Y.Map<unknown>, initiatorUserId: number): boolean {
  const authorId = map.get('authorId')
  if (isAiCommentAuthor(authorId, map.get('authorName'))) return true
  if (authorId === initiatorUserId) return true
  return false
}

async function deleteReplyFromThread(
  session: DocToolContext,
  parentMap: Y.Map<unknown>,
  commentId: string,
  replyId: string,
  initiatorCanManage: () => Promise<boolean>
): Promise<ToolResult> {
  const repliesArrRaw = parentMap.get('replies')
  if (!(repliesArrRaw instanceof Y.Array)) {
    return toolError(`Error: comment "${commentId}" has no replies.`)
  }
  const repliesArr: Y.Array<Y.Map<unknown>> = repliesArrRaw
  for (let j = 0; j < repliesArr.length; j++) {
    const r = repliesArr.get(j)
    if (!(r instanceof Y.Map) || r.get('id') !== replyId) continue
    if (!canDeleteEntry(r, session.initiatorUserId) && !(await initiatorCanManage())) {
      return toolError(`Error: cannot delete reply "${replyId}", it was not authored by markoto or by you, and you do not have document management rights.`)
    }
    const origin = `ai:assistant:${session.sessionId}`
    session.ydoc.transact(() => {
      repliesArr.delete(j, 1)
      parentMap.set('updatedAt', Date.now())
    }, origin)
    return toolOk(`Reply ${replyId} deleted from thread ${commentId}.`)
  }
  return toolError(`Error: reply "${replyId}" not found in thread "${commentId}".`)
}

async function deleteWholeThread(
  session: DocToolContext,
  ycomments: Y.Array<Y.Map<unknown>>,
  index: number,
  parentMap: Y.Map<unknown>,
  commentId: string,
  initiatorCanManage: () => Promise<boolean>
): Promise<ToolResult> {
  if (!canDeleteEntry(parentMap, session.initiatorUserId) && !(await initiatorCanManage())) {
    return toolError(`Error: cannot delete thread "${commentId}", it was not authored by markoto or by you, and you do not have document management rights.`)
  }
  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    ycomments.delete(index, 1)
  }, origin)
  return toolOk(`Thread ${commentId} deleted.`)
}

export const readCommentsTool = defineDocTool({
  name: 'read_comments',
  description: 'Read all comment threads on the document: IDs, anchored line ranges, resolved status, full bodies, and replies (threads past the result size limit are listed one line each). Always call this before creating, replying to, resolving, or deleting any comment so you have current IDs and context.',
  schema: ReadCommentsArgs,
  handler: handleReadComments
})

export const createCommentTool = defineDocTool({
  name: 'create_comment',
  description: 'Anchor a new comment to a line range (start_line, end_line). Use for review notes, to-dos, questions, or to communicate with the user about a specific part of the document. Your comment appears as "markoto" in the sidebar. PREFER leaving a comment over writing nothing when you make an assumption or notice an issue, users see comments in real time.',
  schema: CreateCommentArgs,
  handler: handleCreateComment
})

export const replyToCommentTool = defineDocTool({
  name: 'reply_to_comment',
  description: 'Add a reply to an existing comment thread (by comment_id from read_comments). Use to continue a discussion or respond to a user question left in a thread.',
  schema: ReplyToCommentArgs,
  handler: handleReplyToComment
})

export const resolveCommentTool = defineDocTool({
  name: 'resolve_comment',
  description: 'Resolve or reopen a comment thread. resolved=true hides it from the active list; resolved=false reopens it. Use after addressing a to-do or question from a thread.',
  schema: ResolveCommentArgs,
  handler: handleResolveComment
})

export const deleteCommentTool = defineDocTool({
  name: 'delete_comment',
  description: 'Delete a whole comment thread or a single reply (pass reply_id to target one reply). Only allowed for AI-authored comments or comments by the user who triggered this session, unless that user has document management rights.',
  schema: DeleteCommentArgs,
  handler: handleDeleteComment
})
