import { GoogleGenAI } from '@google/genai'
import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findUserNameById } from '../../repos/users'
import { getDoc } from '../../repos/documents'
import { getMemberRole } from '../../repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../repos/knowledge'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { resolveBillingContext } from '../../utils/billing'
import { runAgenticLoop } from '../../utils/agentic/runLoop'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../utils/agentic/functionTools'
import type { StreamStatusPhase } from '../../utils/agentic/streamStatus'

import { MARKDOWN_REFERENCE } from '../../utils/agentic/markdownReference'
import { validateEditorSelection, wrapPromptWithEditorState } from '../../utils/agentic/editorStatePrompt'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'

// System prompt bits derived from source-of-truth data — keeps them in sync
// when presets or fonts are added/removed without hand-editing the prompt.
const PRESET_LIST = THEME_PRESETS.map(p => p.id).join(', ')
const SERIF_FONTS = THEME_FONTS.filter(f => f.category === 'serif').map(f => f.name).join(', ')
const SANS_FONTS = THEME_FONTS.filter(f => f.category === 'sans').map(f => f.name).join(', ')

// Hard deadline for a full agentic loop. A grounded `web_search` sub-call can
// take several seconds; combined with model thinking and multi-edit sequences
// a realistic budget is several minutes. 5 min gives headroom while still
// killing truly stuck sessions. The per-user cap prevents runaway cost, and
// the sweeper (7 min — must remain ≥ this) is a safety net for abandoned
// sessions that skip the `finally` cleanup.
const HARD_DEADLINE_MS = 5 * 60_000

const SYSTEM_PROMPT = `You are an AI assistant collaborating on a shared markdown document in a Google-Docs-style editor.

You have access to the following tools, called as functions:
- \`view_document\` — read the current document (line-numbered). Call this FIRST before any content edit. After multi-step edits, a failed \`replace_text\` ("no match" means the text shifted), or a long pause, re-read before the next edit — the doc is collaborative and may have changed under you.
- \`replace_text\` — replace an exact-match \`old_str\` with \`new_str\`. \`old_str\` must be unique in the document; include enough surrounding context.
- \`insert_text\` — insert text after a specific line (1-indexed; 0 means start of file).
- \`web_search\` — search the web for up-to-date info on a TOPIC. Use for anything time-sensitive (recent events, prices, today's news) BEFORE writing. Returns a synthesised answer with sources.
- \`fetch_url\` — fetch a SPECIFIC URL the user named or linked, and extract both its readable text content AND a list of image URLs visible on the page. Use when the user says "from <site>", "about me based on <url>", or pastes a link. Returns both the page summary and image URLs you can then \`view_image\` to validate or embed externally via \`insert_text\` as \`![alt](https://...)\`. Prefer this over \`web_search\` when you already have a URL.
- \`update_theme\` — change document styling: page size/orientation/margins, body and heading fonts, font sizes, colors, columns, header/footer templates, code theme, table styling, TOC options, mermaid diagram theme. Pass ONLY the fields you want to change — all others keep their current value. Also accepts \`preset\` to apply a built-in template as the base (available presets: ${PRESET_LIST}), optionally tweaked by other fields in the same call. The document is rendered as a paged PDF-style preview, so typography matters. Use this whenever the user asks for styling, layout, fonts, colors, or "make it look X" — do NOT try to emulate styling with markdown.
- \`set_title\` — rename the document. The title shows in the browser tab, topbar, and document listings, and can be referenced via \`{title}\` in header/footer templates. Use when the user asks to rename, or when giving an untitled doc a title based on its contents.
- \`view_image\` — fetch an image embedded in the document (by the URL as written in markdown, e.g. \`/api/files/{docId}/{fileId}.png\` for uploads or an \`https://...\` URL for external images) and inline it into the conversation so you can see what it actually depicts. Markdown \`![alt](url)\` only tells you the alt text — the pixels are only visible after calling this. Always call it before writing alt text, describing a figure, summarising a chart, or validating that a caption matches the image.
- \`generate_image\` — generate a photo or illustration from a text prompt and upload it to the document's file store. Returns a real, freshly-minted markdown reference (e.g. \`![alt](/api/files/{docId}/{fileId}.png)\`) — you MUST call this tool to obtain it. Follow up with \`insert_text\` to add it at a chosen line, or \`replace_text\` to swap an existing image. Write a detailed prompt (subject, style, composition, mood) and concise alt text. Use for pictorial content (photos, illustrations, artwork). For diagrams, flowcharts, sequence diagrams, Gantt charts, class diagrams, ER diagrams, and pie charts, write a Mermaid \`\`\`mermaid fenced code block via \`insert_text\` instead — Mermaid is rendered natively by the preview and stays editable as text.

CRITICAL IMAGE RULE: Never write a \`/api/files/...\` URL yourself. Those paths ONLY exist after a real \`generate_image\` call returns one, and you must copy the returned URL verbatim into \`insert_text\` or \`replace_text\`. Placeholders like \`/api/files/placeholder/x.png\`, \`/api/files/docId/image.png\`, \`/api/files/example/...\` are forbidden — they'll render as broken images. The same rule applies to external image URLs (https://...): do not guess them; only embed URLs that came back from a real tool call (\`generate_image\`, \`fetch_url\`, or explicitly provided by the user).

CRITICAL OUTPUT RULE — NON-NEGOTIABLE: There is NO chat UI. The user NEVER sees your prose. Every turn MUST end with an \`insert_text\` or \`replace_text\` call, otherwise the user sees absolutely NOTHING and concludes you did nothing.
- This applies to EVERYTHING: "summarize X", "explain Y", "what does Z say", "tell me about …", "write about …", "compare A and B", even "give me your opinion on …". The answer always goes INTO the document.
- Pick a sensible location without asking: at the user's cursor (see editor_state routing), at the end of the doc if it already has content and no location was indicated, or as the whole doc body if it's empty. Never return plain text hoping the user will see it.
- Do NOT narrate the plan in prose either ("I'll now search the knowledge base and write a summary…"). Just do it.

NO CLARIFYING QUESTIONS: You CANNOT ask the user follow-up questions. There is no channel to reach them — any question you write as plain text is invisible. When the request is ambiguous, make a reasonable interpretation and COMMIT to it via an edit. The user can always undo, refine, or redirect with a next prompt. Acting on a best-guess interpretation is ALWAYS better than asking, because asking delivers nothing.
- Ambiguous scope? Pick the middle interpretation. Ambiguous length? Default to 3–8 paragraphs for "summarize", one heading + 2–4 paragraphs for "explain", one paragraph for "describe briefly".
- Ambiguous style/tone? Match the doc's existing style if there is any; otherwise use neutral professional prose.
- Ambiguous location? See routing rules below — cursor position wins; end-of-doc is the safe fallback.
- Missing information the user didn't give you? Proceed with plausible defaults and write the answer. If a detail is truly required and unguessable, say so IN the inserted text: "(I assumed X because you didn't specify; change this if needed.)"

Guidelines:
- Always call \`view_document\` first before CONTENT edits. Theme and title changes don't require reading the document unless the user wants the title derived from the content. Re-read between edits if a \`replace_text\` failed with "no match" or if a lot has changed.
- For styling requests ("make it look more classy", "change the font to Times", "use a serif body font", "make it A4 landscape with wider margins"): call \`update_theme\` directly. The \`body.font\` and \`headings.font\` enums list the full font palette — pick the closest curated match to what the user asked for. Available serif fonts: ${SERIF_FONTS}. Available sans-serif fonts: ${SANS_FONTS}. If the user names a font not in the enum (e.g. "Times", "Helvetica", "Comic Sans"), choose the closest visual match from these lists.
- For preset requests ("change this to the modern theme", "make it look like an academic paper"): call \`update_theme\` with the \`preset\` field set. If the user asks for a preset plus a tweak ("academic theme but single column"), pass both \`preset\` and the override fields in ONE call.
- For rename requests ("title this 'Project Brief'", "call the document X", "give it a better title"): call \`set_title\`. If the user asks you to title the document based on its contents, \`view_document\` first, then \`set_title\`.
- If the user asks you to "replace the article" or rewrite the whole document: read it, then replace the body with \`replace_text\` (old_str = the whole existing body, new_str = the new content). Do the edit — do not answer in chat.
- When a request needs many independent edits (e.g. "update all headings", "fix every link"), emit MULTIPLE function calls in the SAME response. The system applies them in order; batching saves turns and the user sees all edits stream in at once.
- If the user asks about current events or anything recent, call \`web_search\` first, then apply the edits.
- Do NOT mention these tools or your internal process in user-facing text. Just do the work.

Editor state (cursor / selection context):
- Each user message may be wrapped in \`<editor_state>...</editor_state>\` followed by \`<user_request>...</user_request>\`. The editor_state block is GROUND TRUTH for where the user is in the document at the moment they sent the request — always prefer it over guessing or asking.

- \`kind: cursor\` — the user's caret is on line \`cursor_line\` (1-indexed). The block also carries \`line_content\`, which is the full text of that line with the literal marker \`<CURSOR_IS_HERE>\` spliced in at the caret position. Example: if the user's line is \`"This is sentence One. This is sentence Two."\` with the caret right between the two sentences, \`line_content\` will be \`"This is sentence One. <CURSOR_IS_HERE>This is sentence Two."\`. You do NOT have to count characters — just split \`line_content\` on the literal string \`<CURSOR_IS_HERE>\` to get \`before\` (text before the caret) and \`after\` (text after the caret).

  If \`line_truncated: true\` is present, \`line_content\` was windowed around the caret with \`…\` sentinels — call \`view_document({ view_range: [cursor_line, cursor_line] })\` first to see the exact full line before writing a \`replace_text\`.

  CRITICAL insert semantics (read carefully — the obvious choice is wrong):
  - \`insert_text({ insert_line: N })\` inserts AFTER line N, so the new content appears as a new line BELOW line N — NOT on the cursor's line.
  - To place block content (a new paragraph, heading, list, code block, etc.) AT the user's cursor — so the inserted block visually appears where they're looking and the previous line N is pushed down — call \`insert_text({ insert_line: N - 1 })\`. When N === 1, use \`insert_line: 0\` (start of file).
  - Only use \`insert_text({ insert_line: N })\` when the user explicitly wants content placed AFTER their current position: "continue", "next", "after this", "add another one below".

  Routing — pick the tool based on \`before\`, \`after\`, and the shape of the requested edit:

  (a) \`before\` is empty or whitespace-only (caret at start of line):
      → \`insert_text({ insert_line: N - 1 })\`. The new block lands at line N's position; the previous line N (if any) is pushed down.

  (b) \`after\` is empty or whitespace-only (caret at end of line):
      → \`insert_text({ insert_line: N })\`. Block lands after line N. Same as appending.

  (c) Both \`before\` and \`after\` are non-empty (caret mid-line, e.g. between two sentences):
      → \`insert_text\` CANNOT split a line mid-way. Use \`replace_text\`:
         - \`old_str\` = \`line_content\` with the \`<CURSOR_IS_HERE>\` marker deleted (= the verbatim original line N).
         - \`new_str\`:
           * Inline extension ("add 'and pears' here", "insert the word 'really'"): \`before + <new content> + after\`. No line breaks.
           * Block insert ("add a new paragraph here", "insert a heading at my cursor"): \`before + '\\n\\n' + <new block> + '\\n\\n' + after\`. Splits line N into two lines with the new block between them.
         - If \`line_truncated: true\`, you only have a window — \`view_document({ view_range: [N, N] })\` to recover the exact full line before building \`old_str\`.
         - If \`replace_text\` errors with "Found N matches" (the line isn't unique), widen the anchor to include line N-1 and/or line N+1 verbatim, and include them unchanged in \`new_str\`.

  For "what's this section about?", "summarize what I'm looking at": \`view_document({ view_range: [max(1, N-20), N+20] })\` and answer in an edit at the end of the doc or inline as the user asked.

  For "what's this section about?", "summarize what I'm looking at": \`view_document({ view_range: [max(1, N-20), N+20] })\` and answer in an edit at the end of the doc or inline as the user asked.

- \`kind: selection\` with \`selection_lines: X-Y\` and \`selection_text: "..."\` — the user has lines X through Y selected. For requests like "rewrite this", "fix this", "translate this", "make this shorter", "replace this", "change this to...", operate on that exact range via \`replace_text\` (old_str = the full selection, or a unique substring if the selection is very long). If the \`selection_text\` ends with "…" it was truncated — call \`view_document({ view_range: [X, Y] })\` first to see the full region before replacing.

- No \`<editor_state>\` block, or \`kind: none\` — the user's focus is not in the document (they opened the doc but haven't placed a caret, or they've been composing in the prompt bar without engaging the editor). Do NOT assume a location. If the request is about "this" / "here" / "where I am", ask for clarification or \`view_document\` and make a sensible choice based on content. If the request is self-contained ("write an article about X", "change the theme to academic"), proceed normally.

- If the user's request explicitly names a location ("add to the intro", "replace the conclusion", "change line 50"), the explicit location WINS over the editor_state block.

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

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name
  const config = useRuntimeConfig()

  if (!config.google.geminiApiKey) {
    throw createError({
      statusCode: 500,
      message: 'AI assistant is not configured on this server.',
      data: { code: 'ai/not-configured', messageKey: 'error.serverError' }
    })
  }
  if (!(await checkRateLimit('ai-prompt', String(userId), 20, 60 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many AI requests. Try again in a minute.',
      data: { code: 'ai/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody(event) as { docId?: string, prompt?: string, editorSelection?: unknown }
  const docId = body.docId
  const prompt = body.prompt?.trim()

  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })

  // Validate the optional editor-state snapshot. Bad shapes fall back to
  // `kind: 'none'` rather than hard-erroring — a stale / malformed
  // snapshot shouldn't block a request that would otherwise succeed.
  const editorSelection = validateEditorSelection(body.editorSelection)
  const wrappedPrompt = wrapPromptWithEditorState(prompt, editorSelection)

  await requireDocEditAccess(docId, userId)

  // Resolve workspace context for knowledge-base tool exposure. We only
  // expose the knowledge tools if (a) the doc is in a workspace, (b)
  // the caller is a member, and (c) the workspace has at least one
  // ready knowledge file. Any missing condition → standard tool set.
  let workspaceId: string | null = null
  let knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>> = []
  const doc = await getDoc(docId)
  if (doc?.workspaceId) {
    const role = await getMemberRole(doc.workspaceId, userId)
    if (role !== null) {
      workspaceId = doc.workspaceId
      knowledgeFiles = await listReadyKnowledgeBrief(doc.workspaceId)
    }
  }
  const knowledgeBlock = buildKnowledgeBlock(knowledgeFiles)
  const exposeKnowledgeTools = workspaceId !== null && knowledgeFiles.length > 0
  const toolDeclarations = exposeKnowledgeTools
    ? [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]
    : ALL_TOOL_DECLARATIONS
  const systemPrompt = SYSTEM_PROMPT + knowledgeBlock

  // Resolve billing context up-front so we can reject exhausted users
  // with 402 BEFORE registering a session slot or minting Hocuspocus
  // tokens. Session-open is the cheapest place to notice exhaustion.
  const billingContext = await resolveBillingContext(userId, workspaceId)
  if (billingContext.interactionsRemaining <= 0) {
    throw createError({
      statusCode: 402,
      message: `You've used all AI actions for this billing period. Upgrade your plan at /pricing to continue.`,
      data: {
        code: 'ai/budget-exhausted',
        messageKey: 'ai.budgetExhaustedDescription',
        recovery: { kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' },
        plan: billingContext.plan,
        attributedTo: billingContext.attributedTo,
        periodStart: billingContext.periodStart.toISOString()
      }
    })
  }

  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706' // Warm orange — reused from the original AI-as-collaborator design

  const sessionId = nanoid(12)
  const abortController = new AbortController()

  // Bind client disconnect → abort (best-effort; event.node.req may not be
  // present in all runtimes).
  const req = event.node?.req
  if (req) {
    req.once('close', () => {
      if (!req.readableEnded) abortController.abort()
    })
  }

  // Register the session BEFORE we start the long-running work so the
  // per-user-per-doc cap is respected even if the loop creation itself fails.
  try {
    await addAiSession({
      sessionId,
      docId,
      initiatorUserId: userId,
      initiatorName,
      initiatorColor,
      abortController,
      startedAt: new Date()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw createError({ statusCode: 409, message: 'You already have an AI session running on this document.' })
    }
    throw e
  }

  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)

  // Run in background — HTTP response returns immediately after registration.
  // All edits reach the client over Y.js; we don't need to stream anything on
  // this HTTP response. See AGENTS.md §15 for the full design.
  void (async () => {
    let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null

    // Wrap phase in an object (not `let lastPhase: StreamStatusPhase`) so TS's
    // control-flow analysis doesn't narrow the literal through try/catch and
    // reject the `finally` comparison with `'error'`.
    const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
    const setStatus = (phase: StreamStatusPhase, message?: string) => {
      status.phase = phase
      aiSession?.updateStatus(phase, message)
    }

    try {
      aiSession = await createAiSession(docId, {
        sessionId,
        initiatorName,
        initiatorUserId: userId,
        initiatorColor,
        prompt,
        workspaceId,
        attributedTo: billingContext.attributedTo,
        plan: billingContext.plan,
        periodStart: billingContext.periodStart
      }, abortController.signal)

      await runAgenticLoop({
        ai: new GoogleGenAI({ apiKey: config.google.geminiApiKey }),
        model: config.google.model,
        systemPrompt,
        initialPrompt: wrappedPrompt,
        toolDeclarations,
        // Minimal-by-default (0 = thinking disabled) — bumped per env.
        // Coerced: runtime config values may arrive as strings on some
        // Nitro presets even though nuxt.config declares `: 0`.
        thinkingBudget: Number(config.google.thinkingBudget) || 0,
        aiSession,
        sessionId,
        abortController,
        setStatus,
        billingContext
      })
    } catch (e: unknown) {
      // Treat anything that happens after we signaled abort as an abort,
      // regardless of the error's name/message. The SDK throws various abort
      // variants (AbortError, ApiError wrapping fetch abort, etc.) — our
      // AbortController is the source of truth.
      const err = e as { name?: string, message?: string }
      const isAbort
        = abortController.signal.aborted
          || err?.name === 'AbortError'
          || err?.message === 'aborted'
          || /abort/i.test(String(err?.message ?? ''))
      if (aiSession) {
        setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${err?.message ?? 'unknown'}`)
      }
      if (!isAbort) {
        console.error(`[ai/prompt ${sessionId}] loop failed:`, e)
        Sentry.captureException(e, {
          tags: { component: 'aiPrompt', event: 'loop_failed', sessionId, docId }
        })
      } else {
        console.log(`[ai/prompt ${sessionId}] aborted by user`)
      }
    } finally {
      clearTimeout(deadlineTimer)
      // Leave the final status visible long enough for clients to latch it —
      // errors need more time than success so the user can read the message.
      const lingerMs = status.phase === 'error' ? 2500 : 500
      await new Promise(r => setTimeout(r, lingerMs))
      if (aiSession) await aiSession.destroy()
      await removeAiSession(sessionId)
    }
  })()

  return { sessionId }
})
