import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findUserNameById } from '../../repos/users'
import { getDoc } from '../../repos/documents'
import { getMemberRole, listMembers } from '../../repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../repos/knowledge'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { resolveBillingContext } from '../../utils/billing'
import { requireAiProviders } from '../../utils/aiProviders/guard'
import type { ResolvedAiProviders } from '../../utils/aiProviders/resolve'
import { runAgenticLoop } from '../../utils/agentic/runLoop'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../utils/agentic/functionTools'
import {
  buildConversationContextForPrompt,
  shouldRecordToolInMemory,
  summarizeToolCall
} from '../../utils/agentic/conversationMemory'
import {
  appendAiMessage,
  lastActivityAt,
  loadRecentMessages
} from '../../repos/aiSessionMessages'
import type { StreamStatusPhase } from '../../utils/agentic/streamStatus'

import { MARKDOWN_REFERENCE } from '../../utils/agentic/markdownReference'
import { validateEditorSelection, wrapPromptWithEditorState, EDITOR_STATE_INSTRUCTIONS } from '../../utils/agentic/editorStatePrompt'
import { buildDocumentContext } from '../../utils/agentic/documentContextPrompt'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'

// System prompt bits derived from source-of-truth data — keeps them in sync
// when fonts are added/removed without hand-editing the prompt.
const SERIF_FONTS = THEME_FONTS.filter(f => f.category === 'serif').map(f => f.name).join(', ')
const SANS_FONTS = THEME_FONTS.filter(f => f.category === 'sans').map(f => f.name).join(', ')

// Hard deadline for a full agentic loop. A grounded `web_search` sub-call can
// take several seconds; combined with model thinking and multi-edit sequences
// a realistic budget is several minutes. 5 min gives headroom while still
// killing truly stuck sessions. The per-user cap prevents runaway cost, and
// the sweeper (7 min — must remain ≥ this) is a safety net for abandoned
// sessions that skip the `finally` cleanup.
const HARD_DEADLINE_MS = 5 * 60_000

// Tool catalog and per-tool usage hints live in the FunctionDeclarations
// (see `server/utils/agentic/functionTools.ts`) — Mistral receives them
// via the OpenAI tools schema with full Zod-derived descriptions. The
// system prompt below is intentionally BEHAVIOR-only: identity, voice,
// rules that span multiple tools, and policies the schema can't encode.
// Editor-state routing lives in `editorStatePrompt.ts`.
const SYSTEM_PROMPT = `You are markoto, the AI writing partner built into the markoto editor — a collaborative Markdown writing tool. The user's Markdown renders live as a paged document with print-grade typography (paged.js + an 11-section theme system). Multiple humans can edit the same document at once via Y.js + Hocuspocus; you join as a real Y.js client, and every edit you make streams into their live preview as you make it. Workspaces support shared knowledge files, password-protected sharing, import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), server-rendered PDF, and 6 UI languages.

Your name is markoto — same as the product. Refer to yourself as markoto in any user-facing message. Brand voice: precise, calm, craft-focused — "printed field guide on warm paper", not "chatty assistant". Skip greetings, filler ("I'd be happy to…", "Sure!", "Great question!"), and emoji. The user is here to write something good; respect their attention.

CRITICAL OUTPUT RULE — NON-NEGOTIABLE: There is NO chat surface for plain prose. Every turn MUST end with at least ONE tool call. A turn ending in pure prose is invisible to the user. Routing:
- Content requests ("summarize X", "explain Y", "write about …"): answer goes INTO the document via \`insert_text\` / \`replace_text\`. The edit IS the receipt — do NOT also post a confirmation comment or \`message_to_user\` saying "Done".
- Conversational questions outside the document ("what does this section argue?", "is page 1 too dense?", "what is markoto?", "are you Claude/GPT/Mistral?"): \`message_to_user\` (\`is_question: false\`), under 3 sentences.
- Genuine clarification needed (translate without a target language, "make it shorter" on a 200-word doc): \`message_to_user({ is_question: true })\` with a SPECIFIC question, no edits in that turn.
- Doc-wide / non-anchored feedback: \`message_to_user\` over commenting on "the whole document".
- No line-specific issues + no question: do the work and stop. No follow-up.

Comment communication guidelines (load-bearing — comments straddle multiple tools):
- Comments are how you communicate something the user NEEDS to know — assumptions, issues, questions only they can answer. They appear in the sidebar in real time.
- DON'T post a comment to acknowledge work done. The diff is the receipt. Status reports ("Done", "Changes applied", "I rewrote this") are pure noise.
- Worth-commenting: (a) a non-obvious assumption the user should know about ("I assumed UK English — flip me a comment if you wanted US"); (b) an issue you noticed and didn't fix; (c) you couldn't fully complete and want feedback before going further.
- ANCHOR PLACEMENT — non-negotiable: comments MUST anchor to the SPECIFIC lines they're about. Never anchor to "the whole document" (lines 1–N) as a default. If you have nothing line-specific to say, you don't have a useful comment — skip it.
- Picking the line range:
  • Edited a region → anchor to the FINAL lines you wrote (post-edit), not the original ones.
  • Pointing out a duplicate / cross-reference → anchor to the LATER occurrence (so the user lands on the one to consider removing).
  • Document-level concerns ("title doesn't match body") → anchor to the title line, not the whole doc.
- Mention format (workspace docs only): \`@[Display Name](user:ID)\` using IDs from \`<workspace_members>\`. Omit if no members are listed.

CRITICAL IMAGE RULE: Never write a \`/api/files/...\` URL yourself. Those paths only exist after a real \`generate_image\` call returns one — copy the returned URL verbatim into \`insert_text\` / \`replace_text\`. Placeholders (\`/api/files/placeholder/...\`, \`/api/files/docId/image.png\`, \`/api/files/example/...\`) are forbidden — they render as broken images. Same for external image URLs (\`https://...\`): never guess; only embed URLs that came back from a real tool call (\`generate_image\`, \`fetch_url\`) or that the user explicitly provided.

Conversation memory:
- A \`<conversation_history>\` block above (when present) lists prior turns from THIS user on THIS document — their prompts, your tool calls (compacted to name + brief args), and your prior \`message_to_user\` replies. Use it to resolve referring expressions ("that table", "what we just did"). DO NOT echo its contents back at the user — they remember; just refer.
- Tool RESULTS from prior turns are NOT in the block (only the FACT of the call). If you need the actual data again, re-issue the tool call.
- A "(N earlier turns omitted)" sentinel means context older than what's shown exists but isn't loaded. If the user references something that far back and you don't see it, say so honestly — never invent a memory.
- An EMPTY history block means a fresh conversation: this is your first turn or the user paused for ≥1 hour.

Behavior:
- Always \`view_document\` first before content edits. Theme/title changes don't require reading unless the title is derived from content. Re-read after a failed \`replace_text\` ("no match" means the doc shifted under you) or a long pause.
- For "do you remember…" / "what did you base X on" / "revert what we did yesterday" / "when was Y last edited": first check \`<conversation_history>\`; if the answer isn't there, call \`search_activity_log\` with appropriate filters BEFORE answering. Don't fabricate. Cross-doc recall ("what did we do in the marketing doc?") needs \`view_other_document\`.
- Styling requests ("make it look classy", "change the font to Times", "A4 landscape with wider margins"): \`update_theme\` directly — do NOT emulate styling with markdown. Available serif fonts: ${SERIF_FONTS}. Available sans-serif fonts: ${SANS_FONTS}. For a font not in the enum ("Times", "Helvetica"), pick the closest visual match.
- For "mix" / "tweak the current" / "make my theme more X": \`get_theme\` first, AND \`list_themes\` if a named theme is part of the mix. Then \`update_theme\` with the chosen base + sibling overrides.
- For requests that NAME a personal theme ("apply my Brand red", "use the workspace default"): \`list_themes\` first, then \`update_theme\` with \`theme_id\` (saved) or \`from_workspace_default: true\`.
- "Novel" / "book" feel: combine \`preset: 'novel'\` + \`body.dropCap: true\` + \`body.firstLineIndent: true\` + \`body.paragraphSpacing: 0.2\` + \`blocks.hrStyle: 'asterism'\`. "Report" / "tight academic": \`headings.spacingScale: 0.7\` + \`body.paragraphSpacing: 0.4\`.
- Cross-document requests ("summarise this URL into my doc", "pull the conclusion from the Q3 plan"): \`view_other_document\` with the URL/id; if referenced by NAME, \`list_workspace_documents\` first. NEVER fabricate a doc_id.
- "Replace the article" / "rewrite the whole document": read, then \`replace_text\` (old_str = whole body, new_str = new content). Do the edit; don't answer in chat.
- Multiple independent edits ("update all headings", "fix every link"): emit MULTIPLE function calls in the SAME response — they apply in order and the user sees them stream in at once.
- Current events: \`web_search\` first, then apply the edits.
- Ambiguous scope? Pick the middle interpretation and execute. Don't speak unless the assumption is non-obvious.
- Ambiguous length? Default to 3–8 paragraphs for "summarize", one heading + 2–4 paragraphs for "explain".
- Ambiguous style/tone? Match the doc's existing style; otherwise neutral professional prose.
- Never narrate the plan ("I'll now search the knowledge base…"). Just do it.

${EDITOR_STATE_INSTRUCTIONS}

${MARKDOWN_REFERENCE}`

/**
 * Build a `<knowledge_files>` block listing the workspace's ready
 * knowledge files, appended to the system prompt so the model knows
 * which files exist before calling `search_knowledge` /
 * `get_knowledge_file`. Keeps it honest — the model won't fabricate
 * knowledge_ids the user never uploaded.
 *
 * Returns an empty string when there's nothing to expose (non-workspace
 * doc, or workspace has zero ready files). In that case, knowledge
 * tools are ALSO filtered out of the tool list.
 */
function buildKnowledgeBlock(files: Array<{ knowledgeId: string, filename: string, sizeBytes: number, sourceExt: string, tokenCount: number }>): string {
  if (files.length === 0) return ''
  const lines = files.map((f) => {
    const kb = Math.max(1, Math.round(f.sizeBytes / 1024))
    return `- knowledge_id="${f.knowledgeId}" filename="${f.filename}" type=${f.sourceExt} size=${kb}KB tokens=${f.tokenCount}`
  })
  return (
    `\n\n<knowledge_files>\n`
    + `The user's workspace has the following uploaded knowledge files. Call \`search_knowledge\` to query across them, or \`get_knowledge_file\` with a specific knowledge_id when you need the full text. Only ids listed here are valid — do NOT invent or guess.\n\n`
    + `${lines.join('\n')}\n`
    + `</knowledge_files>`
  )
}

/**
 * Build a `<workspace_members>` block listing the workspace member names
 * and IDs for @-mention support in comments. Only appended for workspace
 * docs where the caller is a member. Empty string for standalone docs.
 */
function buildWorkspaceMembersBlock(members: Array<{ userId: number, name: string }>): string {
  if (members.length === 0) return ''
  const lines = members.map(m => `- user_id=${m.userId} name="${m.name}"`)
  return (
    `\n\n<workspace_members>\n`
    + `When mentioning teammates in comments, use @[Name](user:ID) with these user IDs:\n\n`
    + `${lines.join('\n')}\n`
    + `</workspace_members>`
  )
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name

  // Phase 5: text loop runs through LiteLLM unconditionally. The secret
  // validator enforces NUXT_LITELLM_URL + NUXT_LITELLM_MASTER_KEY at boot.
  // Phase 6: app-side rate limit dropped — LiteLLM's per-user-virtual-key
  // rpm_limit is the single enforcement point now.
  const { docId, prompt, wrappedPrompt } = parsePromptInputs(await readBody(event))
  await requireDocEditAccess(docId, userId)

  const doc = await getDoc(docId)
  const wsCtx = await resolvePromptWorkspaceContext(doc?.workspaceId ?? null, userId)
  const documentContextBlock = doc
    ? buildDocumentContext({
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        language: doc.language
      })
    : ''
  const conversationBlock = await loadConversationBlock(docId, userId)
  // Order matters for Mistral prompt caching, which is AUTOMATIC on a stable
  // prompt prefix (cached tokens bill at 10%). The cacheable prefix must lead
  // with the most STABLE content so the longest byte-identical prefix is
  // reused across turns AND across successive prompts on the same doc:
  //   1. SYSTEM_PROMPT        — fully static (identical for every user/doc)
  //   2. documentContextBlock — stable per doc
  //   3. knowledge + members  — stable per workspace
  //   4. conversationBlock    — changes on every user prompt → MUST be last
  // Previously the dynamic conversationBlock led, which invalidated the whole
  // prefix on every follow-up. Verified through the LiteLLM proxy: with this
  // ordering, cached_tokens climbs to ~98% of prompt_tokens on warm requests
  // (~88% input-cost cut). See streamFromLiteLLM in runLoop.ts.
  const systemPrompt = SYSTEM_PROMPT
    + documentContextBlock
    + buildKnowledgeBlock(wsCtx.knowledgeFiles)
    + buildWorkspaceMembersBlock(wsCtx.members)
    + conversationBlock

  // Resolve billing context up-front to lazy-create the LiteLLM virtual
  // key (if not already provisioned) and to pick the right attribution
  // (workspace `(+)` sponsor vs. self). Phase 6: app-side exhaustion
  // pre-check removed — the LiteLLM proxy enforces `max_budget` on the
  // first model call and the runLoop catches `LitellmBudgetExhausted` /
  // `isBudgetExceededError(...)` to surface the upgrade-CTA breadcrumb.
  const billingContext = await resolveBillingContext(userId, wsCtx.workspaceId)
  // BYOK: the user's own provider (or the instance default). No chat
  // provider → 409 `ai/provider-missing` with a link to the settings page.
  const aiProviders = await requireAiProviders(userId, 'chat')

  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706' // Warm orange — reused from the original AI-as-collaborator design

  const sessionId = nanoid(12)
  const abortController = new AbortController()
  const req = event.node?.req
  req?.once?.('close', () => {
    if (!req.readableEnded) abortController.abort()
  })

  await claimAiSession({ sessionId, docId, userId, initiatorName, initiatorColor, abortController })
  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)

  // Run in background — HTTP response returns immediately after registration.
  // All edits reach the client over Y.js; we don't need to stream anything on
  // this HTTP response. See server/utils/agentic/AGENTS.md for the full design.
  void runPromptLoop({
    docId, sessionId, userId, initiatorName, initiatorColor, abortController, deadlineTimer,
    prompt,
    wrappedPrompt,
    systemPrompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    billingContext,
    aiProviders
  })

  return { sessionId }
})

interface PromptInputs { docId: string, prompt: string, wrappedPrompt: string }

/**
 * Validate body shape + the optional editor-state snapshot. Bad
 * snapshot shapes fall back to `kind: 'none'` rather than
 * hard-erroring — a stale / malformed snapshot shouldn't block a
 * request that would otherwise succeed.
 */
function parsePromptInputs(body: { docId?: unknown, prompt?: string, editorSelection?: unknown }): PromptInputs {
  const docId = body.docId
  const prompt = body.prompt?.trim()
  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })
  const editorSelection = validateEditorSelection(body.editorSelection)
  return { docId, prompt, wrappedPrompt: wrapPromptWithEditorState(prompt, editorSelection) }
}

interface PromptWorkspaceCtx {
  workspaceId: string | null
  knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>>
  members: Array<{ userId: number, name: string }>
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
}

/**
 * Knowledge-tool exposure rule: requires (a) the doc is in a workspace,
 * (b) the caller is a member, and (c) the workspace has at least one
 * ready knowledge file. Any missing condition → standard tool set.
 */
async function resolvePromptWorkspaceContext(rawWorkspaceId: string | null, userId: number): Promise<PromptWorkspaceCtx> {
  if (!rawWorkspaceId) return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS }
  const role = await getMemberRole(rawWorkspaceId, userId)
  if (role === null) return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS }
  const [members, knowledgeFiles] = await Promise.all([
    listMembers(rawWorkspaceId),
    listReadyKnowledgeBrief(rawWorkspaceId)
  ])
  const exposeKnowledgeTools = knowledgeFiles.length > 0
  return {
    workspaceId: rawWorkspaceId,
    knowledgeFiles,
    members: members.map(m => ({ userId: m.userId, name: m.name })),
    toolDeclarations: exposeKnowledgeTools
      ? [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]
      : ALL_TOOL_DECLARATIONS
  }
}

/**
 * Load conversation memory for THIS (doc, user) pair. The block is
 * empty when (a) no prior rows exist, or (b) the most recent row is
 * older than the idle gap (60 min) — both treated as a fresh start.
 * Failures degrade silently: a memory read hiccup mustn't block a
 * user-typed prompt; the loop just runs without prior context.
 */
async function loadConversationBlock(docId: string, userId: number): Promise<string> {
  try {
    const lastAt = await lastActivityAt(docId, userId)
    const ctx = await buildConversationContextForPrompt(
      since => loadRecentMessages(docId, userId, { since }),
      lastAt
    )
    return ctx.block
  } catch (e) {
    console.warn(`[ai/prompt] conversation memory load failed: ${e instanceof Error ? e.message : e}`)
    return ''
  }
}

interface ClaimSessionArgs {
  sessionId: string
  docId: string
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
}

async function claimAiSession(args: ClaimSessionArgs): Promise<void> {
  try {
    await addAiSession({
      sessionId: args.sessionId,
      docId: args.docId,
      initiatorUserId: args.userId,
      initiatorName: args.initiatorName,
      initiatorColor: args.initiatorColor,
      abortController: args.abortController,
      startedAt: new Date()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw createError({
        statusCode: 409,
        message: 'You already have an AI session running on this document.',
        data: { code: 'ai/duplicate-session', messageKey: 'ai.errors.duplicateSession' }
      })
    }
    throw e
  }
}

interface PromptLoopArgs {
  docId: string
  sessionId: string
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
  prompt: string
  wrappedPrompt: string
  systemPrompt: string
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  workspaceId: string | null
  billingContext: Awaited<ReturnType<typeof resolveBillingContext>>
  aiProviders: ResolvedAiProviders
}

/**
 * Background fire-and-forget runner. The `status.phase` wrap (instead
 * of `let lastPhase: StreamStatusPhase`) is intentional — TS's
 * control-flow analysis would narrow a literal through try/catch and
 * reject the `finally` comparison with `'error'`.
 */
async function runPromptLoop(args: PromptLoopArgs): Promise<void> {
  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
  const setStatus = (phase: StreamStatusPhase, message?: string) => {
    status.phase = phase
    aiSession?.updateStatus(phase, message)
  }

  await recordUserPromptMemory(args)
  try {
    aiSession = await createAiSession(args.docId, {
      sessionId: args.sessionId,
      initiatorName: args.initiatorName,
      initiatorUserId: args.userId,
      initiatorColor: args.initiatorColor,
      prompt: args.prompt,
      workspaceId: args.workspaceId,
      attributedTo: args.billingContext.attributedTo,
      plan: args.billingContext.plan,
      periodStart: args.billingContext.periodStart,
      virtualKey: args.billingContext.virtualKey,
      aiProviders: args.aiProviders
    }, args.abortController.signal)

    await runAgenticLoop({
      // Phase 5: `ai` arg is for the unit-test seam only; production
      // routes through LiteLLM via the user's virtual key. `model` and
      // `thinkingBudget` are also test-seam-only — the model comes from
      // the session's resolved chat provider (`aiSession.aiProviders.chat`).
      model: '',
      systemPrompt: args.systemPrompt,
      initialPrompt: args.wrappedPrompt,
      toolDeclarations: args.toolDeclarations,
      thinkingBudget: 0,
      aiSession,
      sessionId: args.sessionId,
      abortController: args.abortController,
      setStatus,
      billingContext: args.billingContext,
      onToolCall: (name, validatedArgs) => recordToolCallMemory(args, name, validatedArgs)
    })
  } catch (e: unknown) {
    handlePromptLoopError(e, args, aiSession, setStatus)
  } finally {
    clearTimeout(args.deadlineTimer)
    // Leave the final status visible long enough for clients to latch it —
    // errors need more time than success so the user can read the message.
    const lingerMs = status.phase === 'error' ? 2500 : 500
    await new Promise(r => setTimeout(r, lingerMs))
    if (aiSession) await aiSession.destroy()
    await removeAiSession(args.sessionId)
  }
}

/**
 * Record the user's verbatim prompt FIRST — before the AI Hocuspocus
 * client opens. Memory captures the user's INTENT, and their intent
 * is "I asked X" regardless of whether the downstream sync / model
 * spin-up succeeds. Storing the BARE prompt (not the editor-state-
 * wrapped one) — the model doesn't need to re-see its own
 * scaffolding, just the human-typed words. Failures are swallowed;
 * memory is never load-bearing on the request itself.
 */
async function recordUserPromptMemory(args: PromptLoopArgs): Promise<void> {
  try {
    await appendAiMessage({
      docId: args.docId,
      userId: args.userId,
      sessionId: args.sessionId,
      kind: 'user_prompt',
      body: { text: args.prompt }
    })
  } catch (e) {
    console.warn(`[ai/prompt] user_prompt memory append failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Per-call memory recorder. Compacted to {name, summary} only — the
 * result payload is intentionally NOT recorded so the model re-issues
 * the call if it needs the data again. Skip noise tools
 * (view_document, read_comments, etc.) that the model re-runs every
 * turn just to read the current state.
 */
async function recordToolCallMemory(args: PromptLoopArgs, name: string, validatedArgs: unknown): Promise<void> {
  if (!shouldRecordToolInMemory(name)) return
  try {
    await appendAiMessage({
      docId: args.docId,
      userId: args.userId,
      sessionId: args.sessionId,
      kind: 'tool_call',
      body: { name, summary: summarizeToolCall(name, validatedArgs) }
    })
  } catch (e) {
    console.warn(`[ai/prompt] tool_call memory append failed (${name}): ${e instanceof Error ? e.message : e}`)
  }
}

function handlePromptLoopError(
  e: unknown,
  args: PromptLoopArgs,
  aiSession: Awaited<ReturnType<typeof createAiSession>> | null,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
): void {
  // Treat anything that happens after we signaled abort as an abort,
  // regardless of the error's name/message. The SDK throws various abort
  // variants (AbortError, ApiError wrapping fetch abort, etc.) — our
  // AbortController is the source of truth.
  const err = e as { name?: string, message?: string }
  const isAbort
    = args.abortController.signal.aborted
      || err?.name === 'AbortError'
      || err?.message === 'aborted'
      || /abort/i.test(String(err?.message ?? ''))
  if (aiSession) {
    setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${err?.message ?? 'unknown'}`)
  }
  if (isAbort) {
    console.log(`[ai/prompt ${args.sessionId}] aborted by user`)
  } else {
    console.error(`[ai/prompt ${args.sessionId}] loop failed:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiPrompt', event: 'loop_failed', sessionId: args.sessionId, docId: args.docId }
    })
  }
}
