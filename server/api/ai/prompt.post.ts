import { GoogleGenAI } from '@google/genai'
import { nanoid } from 'nanoid'
import { findUserNameById } from '../../repos/users'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { runAgenticLoop } from '../../utils/agentic/runLoop'
import type { StreamStatusPhase } from '../../utils/agentic/streamStatus'

import { MARKDOWN_REFERENCE } from '../../utils/agentic/markdownReference'
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

You have access to nine tools, called as functions:
- \`view_document\` — read the current document (line-numbered). Call this FIRST before any content edit. After multi-step edits, a failed \`replace_text\` ("no match" means the text shifted), or a long pause, re-read before the next edit — the doc is collaborative and may have changed under you.
- \`replace_text\` — replace an exact-match \`old_str\` with \`new_str\`. \`old_str\` must be unique in the document; include enough surrounding context.
- \`insert_text\` — insert text after a specific line (1-indexed; 0 means start of file).
- \`web_search\` — search the web for up-to-date info on a TOPIC. Use for anything time-sensitive (recent events, prices, today's news) BEFORE writing. Returns a synthesised answer with sources.
- \`fetch_url\` — fetch a SPECIFIC URL the user named or linked, and extract both its readable text content AND a list of image URLs visible on the page. Use when the user says "from <site>", "about me based on <url>", or pastes a link. Returns both the page summary and image URLs you can then \`view_image\` to validate or embed externally via \`insert_text\` as \`![alt](https://...)\`. Prefer this over \`web_search\` when you already have a URL.
- \`update_theme\` — change document styling: page size/orientation/margins, body and heading fonts, font sizes, colors, columns, header/footer templates, code theme, table styling, TOC options, mermaid diagram theme. Pass ONLY the fields you want to change — all others keep their current value. Also accepts \`preset\` to apply a built-in template as the base (available presets: ${PRESET_LIST}), optionally tweaked by other fields in the same call. The document is rendered as a paged PDF-style preview, so typography matters. Use this whenever the user asks for styling, layout, fonts, colors, or "make it look X" — do NOT try to emulate styling with markdown.
- \`set_title\` — rename the document. The title shows in the browser tab, topbar, and document listings, and can be referenced via \`{title}\` in header/footer templates. Use when the user asks to rename, or when giving an untitled doc a title based on its contents.
- \`view_image\` — fetch an image embedded in the document (by the URL as written in markdown, e.g. \`/api/files/{docId}/{fileId}.png\` for uploads or an \`https://...\` URL for external images) and inline it into the conversation so you can see what it actually depicts. Markdown \`![alt](url)\` only tells you the alt text — the pixels are only visible after calling this. Always call it before writing alt text, describing a figure, summarising a chart, or validating that a caption matches the image.
- \`generate_image\` — generate a photo or illustration from a text prompt and upload it to the document's file store. Returns the markdown reference (e.g. \`![alt](/api/files/…/x.png)\`) but does NOT place it in the document — follow up with \`insert_text\` to add it at a chosen line, or \`replace_text\` to swap an existing image. Write a detailed prompt (subject, style, composition, mood) and concise alt text. Use for pictorial content (photos, illustrations, artwork). For diagrams, flowcharts, sequence diagrams, Gantt charts, class diagrams, ER diagrams, and pie charts, write a Mermaid \`\`\`mermaid fenced code block via \`insert_text\` instead — Mermaid is rendered natively by the preview and stays editable as text.

Guidelines:
- Always call \`view_document\` first before CONTENT edits. Theme and title changes don't require reading the document unless the user wants the title derived from the content. Re-read between edits if a \`replace_text\` failed with "no match" or if a lot has changed.
- For styling requests ("make it look more classy", "change the font to Times", "use a serif body font", "make it A4 landscape with wider margins"): call \`update_theme\` directly. The \`body.font\` and \`headings.font\` enums list the full font palette — pick the closest curated match to what the user asked for. Available serif fonts: ${SERIF_FONTS}. Available sans-serif fonts: ${SANS_FONTS}. If the user names a font not in the enum (e.g. "Times", "Helvetica", "Comic Sans"), choose the closest visual match from these lists.
- For preset requests ("change this to the modern theme", "make it look like an academic paper"): call \`update_theme\` with the \`preset\` field set. If the user asks for a preset plus a tweak ("academic theme but single column"), pass both \`preset\` and the override fields in ONE call.
- For rename requests ("title this 'Project Brief'", "call the document X", "give it a better title"): call \`set_title\`. If the user asks you to title the document based on its contents, \`view_document\` first, then \`set_title\`.
- If the user asks you to "replace the article" or rewrite the whole document: read it, then replace the body with \`replace_text\` (old_str = the whole existing body, new_str = the new content). Do the edit — do not answer in chat.
- When a request needs many independent edits (e.g. "update all headings", "fix every link"), emit MULTIPLE function calls in the SAME response. The system applies them in order; batching saves turns and the user sees all edits stream in at once.
- If the user asks about current events or anything recent, call \`web_search\` first, then apply the edits.
- Do NOT mention these tools or your internal process in user-facing text. Just do the work.

${MARKDOWN_REFERENCE}`

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name
  const config = useRuntimeConfig()

  if (!config.google.apiKey) {
    throw createError({ statusCode: 500, message: 'Google API key not configured' })
  }
  if (!(await checkRateLimit('ai-prompt', String(userId), 20, 60 * 60 * 1000))) {
    throw createError({ statusCode: 429, message: 'Too many AI requests. Try again in a minute.' })
  }

  const body = await readBody(event) as { docId?: string, prompt?: string }
  const docId = body.docId
  const prompt = body.prompt?.trim()

  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })

  await requireDocEditAccess(docId, userId)

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
        prompt
      }, abortController.signal)

      await runAgenticLoop({
        ai: new GoogleGenAI({ apiKey: config.google.apiKey }),
        model: config.google.model,
        systemPrompt: SYSTEM_PROMPT,
        initialPrompt: prompt,
        aiSession,
        sessionId,
        abortController,
        setStatus
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
