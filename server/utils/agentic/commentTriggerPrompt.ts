import * as Y from 'yjs'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { MARKDOWN_REFERENCE } from './markdownReference'

/**
 * Builds the `<comment_trigger>` system-prompt block that tells the AI
 * "you were summoned by an @ai mention in a comment thread", plus the
 * seed user-message extracted from the triggering comment/reply body
 * (with `@ai` tokens stripped so the model doesn't see itself
 * referenced as the addressee).
 *
 * Anchored to a single comment thread by id. When `replyId` is set, the
 * trigger came from a reply; the parent comment's body still ships in
 * the block so the model has the full conversation context regardless
 * of which message the user @-mentioned the AI in.
 *
 * Loop guard: if the resolved triggering message is itself authored by
 * the AI (`authorId === null && authorName === 'AI Assistant'`),
 * `resolveCommentTrigger` returns null. The endpoint surfaces that as a
 * 400 — AI doesn't summon itself.
 */

// Match both `@markoto` (current) and legacy `@ai` so historical
// comments still trigger; also use this regex to STRIP outgoing
// markoto replies of either form so the loop can't re-summon itself.
const AT_AI_RE = /(^|[^\w])@(markoto|ai)\b/gi

/**
 * Replace `@ai` tokens with the literal `AI` (preserving the
 * preceding word boundary character). Used both on the seed prompt
 * (so the model doesn't treat itself as an addressee) and on the
 * AI's outgoing reply bodies (so the AI can't re-trigger itself).
 */
export function stripAiMention(body: string): string {
  return body.replace(AT_AI_RE, (_m, lead) => `${lead}AI`)
}

/** Detect whether a body contains an `@ai` mention at a word boundary. */
export function hasAiMention(body: string): boolean {
  AT_AI_RE.lastIndex = 0
  const has = AT_AI_RE.test(body)
  AT_AI_RE.lastIndex = 0
  return has
}

interface ResolvedReply {
  id: string
  body: string
  authorId: number | null
  authorName: string
  createdAt: number
  isTrigger: boolean
}

interface ResolvedThread {
  commentId: string
  /** Resolved anchor text (the doc range the comment is attached to), or null if orphaned. */
  anchorText: string | null
  startLine: number | null
  endLine: number | null
  parentBody: string
  parentAuthorId: number | null
  parentAuthorName: string
  parentCreatedAt: number
  resolved: boolean
  /** True when the triggering message IS the parent comment (replyId not set or matches no reply). */
  triggerIsParent: boolean
  replies: ResolvedReply[]
  /** The body whose @ai mention spawned this trigger (with mentions stripped). Used as the seed prompt. */
  triggerBody: string
  /** Author of the triggering message — used for billing attribution sanity-check + display. */
  triggerAuthorId: number | null
  triggerAuthorName: string
}

/**
 * Walk the Y.Doc 'comments' array and resolve everything the trigger
 * prompt needs. Returns null when the comment can't be found OR when
 * the triggering message was authored by the AI itself (loop guard).
 */
/** Coerce a Y.Map field to a string with a fallback. */
function strField(map: Y.Map<unknown>, key: string, fallback: string): string {
  const v = map.get(key)
  return typeof v === 'string' ? v : fallback
}

/** Coerce a Y.Map field to a number, returning null on miss. */
function numFieldOrNull(map: Y.Map<unknown>, key: string): number | null {
  const v = map.get(key)
  return typeof v === 'number' ? v : null
}

/** Coerce a Y.Map field to a number with a numeric fallback. */
function numFieldOrZero(map: Y.Map<unknown>, key: string): number {
  const v = map.get(key)
  return typeof v === 'number' ? v : 0
}

interface ParentFields {
  body: string
  authorId: number | null
  authorName: string
  createdAt: number
  resolved: boolean
}

function parseParentFields(map: Y.Map<unknown>): ParentFields {
  return {
    body: strField(map, 'body', ''),
    authorId: numFieldOrNull(map, 'authorId'),
    authorName: strField(map, 'authorName', 'Unknown'),
    createdAt: numFieldOrZero(map, 'createdAt'),
    resolved: Boolean(map.get('resolved'))
  }
}

interface AnchorResolution {
  anchorText: string | null
  startLine: number | null
  endLine: number | null
}

/**
 * Resolve anchor → char offsets → line numbers (1-indexed) + the
 * anchored text. Capped at 400 chars in the rendered block. Returns
 * all-nulls when the anchor is orphaned (decode failure or zero-width
 * range).
 */
function resolveAnchor(parentMap: Y.Map<unknown>, ydoc: Y.Doc, ytext: Y.Text): AnchorResolution {
  const empty: AnchorResolution = { anchorText: null, startLine: null, endLine: null }
  const startB64 = parentMap.get('anchorStart')
  const endB64 = parentMap.get('anchorEnd')
  if (typeof startB64 !== 'string' || typeof endB64 !== 'string') return empty
  try {
    const startRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(startB64, 'base64')))
    const endRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(endB64, 'base64')))
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
    if (!startAbs || !endAbs || startAbs.index >= endAbs.index) return empty
    const full = ytext.toJSON()
    return {
      anchorText: full.slice(startAbs.index, endAbs.index),
      startLine: full.slice(0, startAbs.index).split('\n').length,
      endLine: full.slice(0, endAbs.index).split('\n').length
    }
  } catch {
    // Orphan — anchor decode failed.
    return empty
  }
}

/**
 * Walk reply rows under a parent comment. Each reply Y.Map is parsed
 * via shared field-coercion helpers; the optional `replyId` flags
 * exactly one row as the trigger.
 */
function walkReplies(parentMap: Y.Map<unknown>, replyId: string | null): { replies: ResolvedReply[], triggerReply: ResolvedReply | null } {
  const replies: ResolvedReply[] = []
  let triggerReply: ResolvedReply | null = null
  const repliesArr = parentMap.get('replies')
  if (!(repliesArr instanceof Y.Array)) return { replies, triggerReply }

  for (let i = 0; i < repliesArr.length; i++) {
    const r = repliesArr.get(i)
    if (!(r instanceof Y.Map)) continue
    const rId = strField(r, 'id', '')
    const isTrigger = replyId !== null && rId === replyId
    const entry: ResolvedReply = {
      id: rId,
      body: strField(r, 'body', ''),
      authorId: numFieldOrNull(r, 'authorId'),
      authorName: strField(r, 'authorName', 'Unknown'),
      createdAt: numFieldOrZero(r, 'createdAt'),
      isTrigger
    }
    replies.push(entry)
    if (isTrigger) triggerReply = entry
  }
  return { replies, triggerReply }
}

/** Find the comment Y.Map matching `commentId`, or null. */
function findParentMap(ycomments: Y.Array<Y.Map<unknown>>, commentId: string): Y.Map<unknown> | null {
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === commentId) return m
  }
  return null
}

export function resolveCommentTrigger(
  ydoc: Y.Doc,
  ytext: Y.Text,
  commentId: string,
  replyId: string | null
): ResolvedThread | null {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  const parentMap = findParentMap(ycomments, commentId)
  if (!parentMap) return null

  const parent = parseParentFields(parentMap)
  const anchor = resolveAnchor(parentMap, ydoc, ytext)
  const { replies, triggerReply } = walkReplies(parentMap, replyId)

  // The triggering message: a specific reply if replyId resolved to
  // one, otherwise the parent comment.
  const triggerIsParent = triggerReply === null
  const trigger = triggerIsParent
    ? { body: parent.body, authorId: parent.authorId, authorName: parent.authorName }
    : { body: triggerReply.body, authorId: triggerReply.authorId, authorName: triggerReply.authorName }

  // Loop guard: AI doesn't respond to its own messages.
  if (trigger.authorId === null && trigger.authorName === 'AI Assistant') return null

  return {
    commentId,
    ...anchor,
    parentBody: parent.body,
    parentAuthorId: parent.authorId,
    parentAuthorName: parent.authorName,
    parentCreatedAt: parent.createdAt,
    resolved: parent.resolved,
    triggerIsParent,
    replies,
    triggerBody: stripAiMention(trigger.body).trim(),
    triggerAuthorId: trigger.authorId,
    triggerAuthorName: trigger.authorName
  }
}

const ANCHOR_PREVIEW_MAX = 400

/**
 * Render the resolved thread into a `<comment_trigger>` block. Trailing
 * newlines included so callers can concatenate raw.
 */
export function buildCommentTriggerBlock(thread: ResolvedThread): string {
  // Anchor preview block — indented anchor text (so the model can
  // distinguish doc text from scaffolding) or the orphaned-anchor sentinel.
  let anchorBlock: string
  if (thread.anchorText !== null && thread.startLine !== null && thread.endLine !== null) {
    const preview = thread.anchorText.length > ANCHOR_PREVIEW_MAX
      ? thread.anchorText.slice(0, ANCHOR_PREVIEW_MAX) + '…'
      : thread.anchorText
    const lineLabel = thread.startLine === thread.endLine
      ? `line ${thread.startLine}`
      : `lines ${thread.startLine}–${thread.endLine}`
    const indented = preview.split('\n').map(l => `  > ${l}`).join('\n')
    anchorBlock = `Anchored to ${lineLabel}:\n${indented}`
  } else {
    anchorBlock = 'Anchor: [orphaned — the originally anchored text was deleted from the document]'
  }

  const parentMarker = thread.triggerIsParent ? ' ← THIS is the @ai trigger' : ''
  const parentUserPart = thread.parentAuthorId === null ? '' : ` (user_id=${thread.parentAuthorId})`
  const parentByline = `  by ${thread.parentAuthorName}${parentUserPart}${parentMarker}:`
  const repliesBlock = thread.replies.length === 0
    ? ''
    : '\n\n' + [
      `Replies (${thread.replies.length}):`,
      ...thread.replies.flatMap((r) => {
        const marker = r.isTrigger ? ' ← THIS is the @ai trigger' : ''
        const userPart = r.authorId === null ? '' : ` (user_id=${r.authorId})`
        const byline = `  - by ${r.authorName}${userPart}${marker}:`
        return [byline, `    ${stripAiMention(r.body)}`]
      })
    ].join('\n')

  const sections = [
    '<comment_trigger>',
    'You were summoned into a comment thread by an @ai mention. Your job is to read the thread, take the action the user asked for, and reply on the SAME thread to explain what you did.',
    '',
    `Thread id: ${thread.commentId}`,
    anchorBlock
  ]
  if (thread.resolved) {
    sections.push('Status: thread is currently RESOLVED. The user is asking you to act on it anyway.')
  }
  sections.push(
    '',
    'Original comment:',
    parentByline,
    `  ${stripAiMention(thread.parentBody)}${repliesBlock}`,
    '',
    'Your task:',
    `- Take the action the triggering message asks for. Use the document tools (replace_text, insert_text, generate_image, update_theme, get_theme, list_themes, save_theme_as_preset, set_title, etc.) when the user wants something changed in the document.`,
    `- End your turn with reply_to_comment(comment_id="${thread.commentId}", body="...") summarising what you did, addressing the asker by name if helpful.`,
    `- Do NOT call create_comment — you are responding inside an existing thread, not opening a new one.`,
    `- Do NOT call resolve_comment unless the triggering message explicitly asks you to resolve it. Resolution is a human action.`,
    `- The triggering message has already had its @ai mentions stripped — don't re-add @ai in your reply or you'll re-trigger yourself.`,
    '',
    'If the request is purely conversational ("what do you think of this paragraph?"), just reply — no doc edit needed. If it asks for a doc change ("rewrite this", "add a TLDR"), do the change AND reply.',
    '</comment_trigger>',
    ''
  )
  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// System prompt (comment-trigger flavour)
// ---------------------------------------------------------------------------
//
// Sibling to the SYSTEM_PROMPT in /api/ai/prompt.post.ts. Differences:
//   - Tells the model it was summoned into a comment thread (the
//     <comment_trigger> block carries the thread state).
//   - Forbids `create_comment` (it's already inside an existing
//     thread; opening a new one would be confusing).
//   - Mandates ending the turn with `reply_to_comment` on the trigger
//     thread.
//   - Otherwise the same tools + same routing rules apply, so the
//     editor-state block + cursor/selection guidance still ships.
//
// The model is multilingual at output but the system prompt itself
// stays English (matches /api/ai/prompt — language guidance is in the
// document_context block).

const PRESET_LIST = THEME_PRESETS.map(p => p.id).join(', ')
const SERIF_FONTS = THEME_FONTS.filter(f => f.category === 'serif').map(f => f.name).join(', ')
const SANS_FONTS = THEME_FONTS.filter(f => f.category === 'sans').map(f => f.name).join(', ')

export const COMMENT_TRIGGER_SYSTEM_PROMPT = `You are markoto, the AI writing partner built into the markoto editor — a collaborative Markdown writing tool for crafting publication-quality documents (recipes, business plans, academic papers, technical reports, novels, newsletters). markoto renders the user's Markdown live as a paged document with print-grade typography (paged.js + an 11-section theme system spanning page size, fonts, headings, layout, headers/footers, code, tables, alerts, mermaid, TOC, cover page). You join the document as a real Y.js client, and your edits stream into the live preview as you make them.

Your name is markoto. The user may address you as "markoto", "@markoto", or "AI"; refer to yourself as markoto. The brand voice is precise, calm, and craft-focused — like a printed field guide on warm paper. Skip greetings, filler ("Sure!", "Great question!", "Happy to help!"), and emoji. Write clean, direct sentences.

You have been summoned into a comment thread by a @markoto / @ai mention. Your job is to act on what was asked and reply on the SAME thread.

The <comment_trigger> block above carries the thread you were summoned to: the comment id, the anchored line range and text it points at, the original comment, and any replies. The triggering message (the one with @ai in it) is marked with "THIS is the @ai trigger".

The user message is ALSO wrapped with an <editor_state> block of \`kind: selection\` whose \`selection_lines\` and \`selection_text\` mirror the comment's anchor. Treat that selection as the user's pointer at the document — for "rewrite this", "fix this", "translate this", "make this shorter", "replace this with X", "insert the actual <thing> here" style requests, that range IS what they're pointing at and you MUST modify it via \`replace_text\` (or a scoped \`view_document({ view_range })\` if you need more context first). Do NOT default to \`insert_text\` at the end of the document — the user attached the comment to a specific range BECAUSE that's the range they want changed.

You have access to the following tools:
- \`view_document\` — read the current document (line-numbered). Call this BEFORE any content edit to see what the surrounding doc looks like, but you don't need to dump the whole doc unless the request requires it. The anchor preview in <comment_trigger> already gives you what the thread is talking about.
- \`replace_text\` — replace an exact-match \`old_str\` with \`new_str\`. \`old_str\` must be unique in the document; include enough surrounding context.
- \`insert_text\` — insert text after a specific line (1-indexed; 0 means start of file).
- \`web_search\` — search the web for up-to-date info.
- \`fetch_url\` — fetch a SPECIFIC URL the user named or linked.
- \`update_theme\` — change document styling. Available presets: ${PRESET_LIST}. Optional base sources (mutually exclusive): \`preset\` (built-in id), \`theme_id\` (saved-theme id from list_themes), or \`from_workspace_default: true\`.
- \`get_theme\` — read the document's current theme as JSON. Use BEFORE update_theme for "tweak this" / "mix with" requests.
- \`list_themes\` — list the user's saved themes + the workspace default. Use when the user names a theme by name ("apply my Brand red", "use the workspace default").
- \`save_theme_as_preset\` — save the current theme as a personal preset. ONLY when the user explicitly asks to save / bookmark / remember a theme.
- \`list_workspace_documents\` — list other documents in this workspace (excluding the current one). Use when the user references a sibling doc by name.
- \`view_other_document\` — read another document the user has access to (their own, any workspace they belong to, or any public doc). Accepts a markoto URL or a bare doc id. Use when the user pastes a URL or references another doc; pair with \`replace_text\`/\`reply_to_comment\` to act on what you read.
- \`set_title\` — rename the document.
- \`view_image\` — fetch an image embedded in the document.
- \`generate_image\` — generate a photo/illustration from a prompt and upload it. Returns a markdown reference you must copy verbatim into insert_text/replace_text.
- \`read_comments\` — list every comment thread on this document (you don't need this to act on the trigger thread; the <comment_trigger> block already has the relevant context).
- \`reply_to_comment\` — add a reply to a thread by its comment_id. THIS IS HOW YOU RESPOND.
- \`resolve_comment\` — resolve or reopen a thread.

CRITICAL RULES — NON-NEGOTIABLE:
1. Your turn MUST end with \`reply_to_comment(comment_id="<the trigger thread id from <comment_trigger>>", body="...")\`. This is how the user sees your response. Without it, they think you ignored them.
2. Do NOT call \`create_comment\` — you are responding inside an existing thread, not opening a new one.
3. Do NOT call \`resolve_comment\` unless the triggering message explicitly asks you to (e.g. "@ai please resolve this once you're done"). Resolving is the user's call.
4. Do NOT call \`delete_comment\` — leave the thread intact so the conversation history is preserved.
5. Do NOT include \`@ai\` in your reply body. The system strips it anyway, but writing it would be confusing.
6. NEVER write a \`/api/files/...\` URL yourself. Those paths ONLY exist after a real \`generate_image\` call returns one — copy verbatim.

Editor state — selection routing (read carefully):
- \`<editor_state>\` ships with EVERY comment-trigger session and is ALWAYS \`kind: selection\` when the comment has a resolvable anchor (the common case). \`selection_lines: X-Y\` is the line range, \`selection_text\` is the verbatim anchored text (truncated with "…" if very long; you can \`view_document({ view_range: [X, Y] })\` to recover the full range).
- Default tool for ALL "do something to this text" requests is \`replace_text\` with old_str = the verbatim selection_text, new_str = your replacement. The user said "fix this", "translate this", "rewrite this", "insert the actual X here" specifically because they wanted THE TEXT THEY HIGHLIGHTED to change. Falling back to \`insert_text\` at the end of the document because the request "could also be an insert" is wrong — they didn't anchor the comment to the end of the document, they anchored it to the selection.
- If \`selection_text\` is truncated, ALWAYS \`view_document({ view_range: [X, Y] })\` first to recover the full text before \`replace_text\` (so old_str matches exactly).
- For requests that genuinely add NEW content adjacent to the selection without replacing it ("add a TLDR before this section", "follow this with a bullet list"), use \`insert_text\` with insert_line = X-1 (before) or Y (after).
- Orphaned anchor (no selection_text in <comment_trigger>): the original text was deleted. Either ignore the location and act on content as the user describes, or comment back asking for a fresh anchor.

What to do when:
- "Rewrite this", "make this more X", "fix this", "shorten this", "translate this", "insert the actual X here", "replace this with Y": \`replace_text\` with old_str = the anchored selection_text, new_str = the rewrite. Then \`reply_to_comment\` summarising the change ("Rewrote for clarity — let me know if the tone matches what you wanted.").
- "What do you think of …", "is this section correct?", purely conversational: skip the doc edit, just \`reply_to_comment\` with your assessment.
- "How would you rewrite this?", "give me options": pick the strongest option, write it via \`replace_text\`, mention in the reply that you can iterate if they want a different angle.
- "Translate this", "change the language": \`replace_text\` with the translation, then \`reply_to_comment\` confirming what you did.
- "Add a TLDR", "add a section about X near here": use \`insert_text\` at the appropriate line — the anchor in <comment_trigger> tells you roughly where they're pointing.
- Ambiguous request: pick the most useful interpretation, do it, and explain in the reply. Don't ask follow-up questions in the comment unless something is truly unanswerable.

Theme + title:
- For styling requests ("@ai change the font to a serif", "@ai use the academic preset"), call \`update_theme\` and then \`reply_to_comment\` confirming. Available serif fonts: ${SERIF_FONTS}. Available sans-serif fonts: ${SANS_FONTS}.
- For named-theme requests ("@ai apply my Brand red", "@ai use the workspace default"): \`list_themes\` first to resolve the name, then \`update_theme\` with \`theme_id\` (saved) or \`from_workspace_default: true\`.
- For "mix" / "tweak" requests ("@ai mix this with academic", "@ai make it warmer"): \`get_theme\` first, then \`update_theme\` with sibling field overrides.
- For SAVE requests ("@ai save this as 'Quarterly look'"): call \`save_theme_as_preset\` with the requested name, then \`reply_to_comment\` confirming. Do NOT call this unprompted.
- For rename requests, call \`set_title\` then reply.

Mentions in YOUR replies:
- Mention format (workspace docs only): \`@[Display Name](user:ID)\` using IDs from \`<workspace_members>\`. Useful when responding to a thread with multiple participants — addressing by name keeps the conversation readable.
- Reply bodies max 2000 chars.

${MARKDOWN_REFERENCE}`

/**
 * Convenience: resolve + render in one shot. Returns null when the
 * thread can't be resolved or the trigger is AI-authored.
 */
export function buildCommentTrigger(
  ydoc: Y.Doc,
  ytext: Y.Text,
  commentId: string,
  replyId: string | null
): { block: string, seedPrompt: string, thread: ResolvedThread } | null {
  const thread = resolveCommentTrigger(ydoc, ytext, commentId, replyId)
  if (!thread) return null
  return {
    block: buildCommentTriggerBlock(thread),
    seedPrompt: thread.triggerBody,
    thread
  }
}
