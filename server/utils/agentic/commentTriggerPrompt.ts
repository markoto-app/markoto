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
export function resolveCommentTrigger(
  ydoc: Y.Doc,
  ytext: Y.Text,
  commentId: string,
  replyId: string | null
): ResolvedThread | null {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  let parentMap: Y.Map<unknown> | null = null
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === commentId) {
      parentMap = m
      break
    }
  }
  if (!parentMap) return null

  const parentBody = typeof parentMap.get('body') === 'string' ? (parentMap.get('body') as string) : ''
  const parentAuthorId = typeof parentMap.get('authorId') === 'number' ? (parentMap.get('authorId') as number) : null
  const parentAuthorName = typeof parentMap.get('authorName') === 'string' ? (parentMap.get('authorName') as string) : 'Unknown'
  const parentCreatedAt = typeof parentMap.get('createdAt') === 'number' ? (parentMap.get('createdAt') as number) : 0
  const resolved = Boolean(parentMap.get('resolved'))

  // Resolve anchor → char offsets → line numbers (1-indexed) and the
  // anchored text itself. Capped at 400 chars in the rendered block.
  let anchorText: string | null = null
  let startLine: number | null = null
  let endLine: number | null = null
  const startB64 = parentMap.get('anchorStart')
  const endB64 = parentMap.get('anchorEnd')
  if (typeof startB64 === 'string' && typeof endB64 === 'string') {
    try {
      const startRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(startB64, 'base64')))
      const endRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(endB64, 'base64')))
      const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
      const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
      if (startAbs && endAbs && startAbs.index < endAbs.index) {
        const full = ytext.toString()
        anchorText = full.slice(startAbs.index, endAbs.index)
        startLine = full.slice(0, startAbs.index).split('\n').length
        endLine = full.slice(0, endAbs.index).split('\n').length
      }
    } catch {
      // Orphan — anchor decode failed. Anchor stays null.
    }
  }

  // Walk replies; capture each + flag the trigger reply.
  const replies: ResolvedReply[] = []
  let triggerReply: ResolvedReply | null = null
  const repliesArr = parentMap.get('replies')
  if (repliesArr instanceof Y.Array) {
    for (let i = 0; i < repliesArr.length; i++) {
      const r = repliesArr.get(i)
      if (!(r instanceof Y.Map)) continue
      const rId = typeof r.get('id') === 'string' ? (r.get('id') as string) : ''
      const rBody = typeof r.get('body') === 'string' ? (r.get('body') as string) : ''
      const rAuthorId = typeof r.get('authorId') === 'number' ? (r.get('authorId') as number) : null
      const rAuthorName = typeof r.get('authorName') === 'string' ? (r.get('authorName') as string) : 'Unknown'
      const rCreatedAt = typeof r.get('createdAt') === 'number' ? (r.get('createdAt') as number) : 0
      const isTrigger = replyId !== null && rId === replyId
      const entry: ResolvedReply = {
        id: rId,
        body: rBody,
        authorId: rAuthorId,
        authorName: rAuthorName,
        createdAt: rCreatedAt,
        isTrigger
      }
      replies.push(entry)
      if (isTrigger) triggerReply = entry
    }
  }

  // The triggering message: a specific reply if replyId resolved to one,
  // otherwise the parent comment.
  const triggerIsParent = triggerReply === null
  const triggerBody = triggerIsParent ? parentBody : triggerReply!.body
  const triggerAuthorId = triggerIsParent ? parentAuthorId : triggerReply!.authorId
  const triggerAuthorName = triggerIsParent ? parentAuthorName : triggerReply!.authorName

  // Loop guard: AI doesn't respond to its own messages.
  if (triggerAuthorId === null && triggerAuthorName === 'AI Assistant') return null

  return {
    commentId,
    anchorText,
    startLine,
    endLine,
    parentBody,
    parentAuthorId,
    parentAuthorName,
    parentCreatedAt,
    resolved,
    triggerIsParent,
    replies,
    triggerBody: stripAiMention(triggerBody).trim(),
    triggerAuthorId,
    triggerAuthorName
  }
}

const ANCHOR_PREVIEW_MAX = 400

/**
 * Render the resolved thread into a `<comment_trigger>` block. Trailing
 * newlines included so callers can concatenate raw.
 */
export function buildCommentTriggerBlock(thread: ResolvedThread): string {
  const lines: string[] = []
  lines.push('<comment_trigger>')
  lines.push('You were summoned into a comment thread by an @ai mention. Your job is to read the thread, take the action the user asked for, and reply on the SAME thread to explain what you did.')
  lines.push('')
  lines.push(`Thread id: ${thread.commentId}`)

  if (thread.anchorText !== null && thread.startLine !== null && thread.endLine !== null) {
    const preview = thread.anchorText.length > ANCHOR_PREVIEW_MAX
      ? thread.anchorText.slice(0, ANCHOR_PREVIEW_MAX) + '…'
      : thread.anchorText
    const lineLabel = thread.startLine === thread.endLine
      ? `line ${thread.startLine}`
      : `lines ${thread.startLine}–${thread.endLine}`
    lines.push(`Anchored to ${lineLabel}:`)
    // Indent the anchor preview so the model can clearly distinguish doc
    // text from prompt scaffolding even if the preview itself contains
    // line breaks.
    const indented = preview.split('\n').map(l => `  > ${l}`).join('\n')
    lines.push(indented)
  } else {
    lines.push('Anchor: [orphaned — the originally anchored text was deleted from the document]')
  }

  if (thread.resolved) {
    lines.push('Status: thread is currently RESOLVED. The user is asking you to act on it anyway.')
  }

  lines.push('')
  lines.push('Original comment:')
  const parentMarker = thread.triggerIsParent ? ' ← THIS is the @ai trigger' : ''
  const parentByline = `  by ${thread.parentAuthorName}${thread.parentAuthorId !== null ? ` (user_id=${thread.parentAuthorId})` : ''}${parentMarker}:`
  lines.push(parentByline)
  lines.push(`  ${stripAiMention(thread.parentBody)}`)

  if (thread.replies.length > 0) {
    lines.push('')
    lines.push(`Replies (${thread.replies.length}):`)
    for (const r of thread.replies) {
      const marker = r.isTrigger ? ' ← THIS is the @ai trigger' : ''
      const byline = `  - by ${r.authorName}${r.authorId !== null ? ` (user_id=${r.authorId})` : ''}${marker}:`
      lines.push(byline)
      lines.push(`    ${stripAiMention(r.body)}`)
    }
  }

  lines.push('')
  lines.push('Your task:')
  lines.push(`- Take the action the triggering message asks for. Use the document tools (replace_text, insert_text, generate_image, update_theme, get_theme, list_themes, save_theme_as_preset, set_title, etc.) when the user wants something changed in the document.`)
  lines.push(`- End your turn with reply_to_comment(comment_id="${thread.commentId}", body="...") summarising what you did, addressing the asker by name if helpful.`)
  lines.push(`- Do NOT call create_comment — you are responding inside an existing thread, not opening a new one.`)
  lines.push(`- Do NOT call resolve_comment unless the triggering message explicitly asks you to resolve it. Resolution is a human action.`)
  lines.push(`- The triggering message has already had its @ai mentions stripped — don't re-add @ai in your reply or you'll re-trigger yourself.`)
  lines.push('')
  lines.push('If the request is purely conversational ("what do you think of this paragraph?"), just reply — no doc edit needed. If it asks for a doc change ("rewrite this", "add a TLDR"), do the change AND reply.')
  lines.push('</comment_trigger>')
  lines.push('')
  return lines.join('\n')
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
