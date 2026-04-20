import { GoogleGenAI } from '@google/genai'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { runAgenticLoop } from '../../utils/agentic/runLoop'
import type { StreamStatusPhase } from '../../utils/agentic/streamStatus'

// Hard deadline for a full agentic loop. A grounded `web_search` sub-call can
// take several seconds; combined with model thinking and multi-edit sequences
// a realistic budget is several minutes. 5 min gives headroom while still
// killing truly stuck sessions. The per-user cap prevents runaway cost, and
// the sweeper (7 min — must remain ≥ this) is a safety net for abandoned
// sessions that skip the `finally` cleanup.
const HARD_DEADLINE_MS = 5 * 60_000

import { MARKDOWN_REFERENCE } from '../../utils/agentic/markdownReference'

const SYSTEM_PROMPT = `You are an AI assistant collaborating on a shared markdown document in a Google-Docs-style editor.

You have access to four tools, called as functions:
- \`view_document\` — read the current document (line-numbered). Call this FIRST before any edit so you're matching against current content.
- \`replace_text\` — replace an exact-match \`old_str\` with \`new_str\`. \`old_str\` must be unique in the document; include enough surrounding context.
- \`insert_text\` — insert text after a specific line (1-indexed; 0 means start of file).
- \`web_search\` — search the web for up-to-date info. Use for anything time-sensitive (recent events, prices, today's news) BEFORE writing.

Guidelines:
- Always call \`view_document\` first to see current content, then decide what to change.
- If the user asks you to "replace the article" or rewrite the whole document: read it, then replace the body with \`replace_text\` (old_str = the whole existing body, new_str = the new content). Do the edit — do not answer in chat.
- When a request needs many independent edits (e.g. "update all headings", "fix every link"), emit MULTIPLE function calls in the SAME response. The system applies them in order; batching saves turns and the user sees all edits stream in at once.
- If the user asks about current events or anything recent, call \`web_search\` first, then apply the edits.
- Do NOT produce long text responses — the user sees your edits live in the document. Keep any chatter terse.
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

  const body = await readBody(event) as { docId?: string; prompt?: string }
  const docId = body.docId
  const prompt = body.prompt?.trim()

  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })

  const db = useDatabase()
  const userRow = (await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1))[0]
  const initiatorName = userRow?.name || userName
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
      const err = e as { name?: string; message?: string }
      const isAbort =
        abortController.signal.aborted ||
        err?.name === 'AbortError' ||
        err?.message === 'aborted' ||
        /abort/i.test(String(err?.message ?? ''))
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
      await new Promise((r) => setTimeout(r, lingerMs))
      if (aiSession) await aiSession.destroy()
      await removeAiSession(sessionId)
    }
  })()

  return { sessionId }
})
