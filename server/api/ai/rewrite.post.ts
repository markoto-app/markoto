import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import * as Y from 'yjs'

const REWRITE_SYSTEM = `Rewrite the text inside <text>...</text> according to the instruction inside <instruction>...</instruction>.

The full document is provided inside <document>...</document> for context — use it to match tone, style, and terminology, but rewrite ONLY the selection. Do not reproduce surrounding content.

Reply with ONLY the rewritten text — no preamble, no commentary, no markdown fences, no quotation marks wrapping the whole thing. Match the register and length of the original unless the instruction explicitly asks otherwise.`

const REWRITE_MODEL = 'claude-haiku-4-5'

export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const userId = session.user.id as number
  const userName = session.user.name as string
  const config = useRuntimeConfig()

  if (!config.anthropic.apiKey) {
    throw createError({ statusCode: 500, message: 'Anthropic API key not configured' })
  }

  if (!checkRateLimit('ai-rewrite', String(userId), 30, 60 * 60 * 1000)) {
    throw createError({ statusCode: 429, message: 'Too many AI requests. Try again in a minute.' })
  }

  const body = await readBody(event) as {
    docId?: string
    selectionText?: string
    selectionFrom?: number
    selectionTo?: number
    relFrom?: unknown
    relTo?: unknown
    prompt?: string
  }

  const docId = body.docId
  const selectionText = body.selectionText
  const selectionFrom = body.selectionFrom
  const selectionTo = body.selectionTo
  const prompt = body.prompt?.trim()

  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (typeof selectionText !== 'string' || !selectionText.length) {
    throw createError({ statusCode: 400, message: 'Missing or empty selectionText' })
  }
  if (selectionText.length > 20000) throw createError({ statusCode: 400, message: 'Selection too long (max 20000 chars)' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 2000) throw createError({ statusCode: 400, message: 'Prompt too long (max 2000 chars)' })
  if (typeof selectionFrom !== 'number' || typeof selectionTo !== 'number' || selectionTo <= selectionFrom) {
    throw createError({ statusCode: 400, message: 'Invalid selection range' })
  }

  const db = useDatabase()
  const userRow = db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get()
  const initiatorName = userRow?.name || userName
  const initiatorColor = '#d97706'

  const sessionId = nanoid(12)
  const abortController = new AbortController()

  try {
    addAiSession({
      sessionId,
      docId,
      initiatorUserId: userId,
      initiatorName,
      initiatorColor,
      abortController,
      startedAt: Date.now()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw createError({ statusCode: 409, message: 'You already have Claude running on this document.' })
    }
    throw e
  }

  const deadlineTimer = setTimeout(() => abortController.abort(), 30_000)

  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  try {
    aiSession = await createAiSession(docId, {
      sessionId,
      initiatorName,
      initiatorUserId: userId,
      initiatorColor,
      prompt: `(rewrite) ${prompt}`
    }, abortController.signal)

    aiSession.updateStatus('thinking', 'Rewriting…')

    // Pull the current document for context. Cap to avoid runaway token usage on huge docs;
    // the selection itself is also included explicitly in <text> so Claude can't miss it.
    const MAX_DOC_CONTEXT = 40000
    let documentContext = aiSession.ytext.toString()
    if (documentContext.length > MAX_DOC_CONTEXT) {
      // Keep a window around the selection
      const halfWindow = MAX_DOC_CONTEXT / 2
      const start = Math.max(0, selectionFrom - halfWindow)
      const end = Math.min(documentContext.length, selectionTo + halfWindow)
      documentContext = (start > 0 ? '…' : '') + documentContext.slice(start, end) + (end < documentContext.length ? '…' : '')
    }

    const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey })
    const response = await anthropic.messages.create({
      model: REWRITE_MODEL,
      max_tokens: Math.min(4096, selectionText.length * 4 + 200),
      system: REWRITE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `<document>${documentContext}</document>\n\n<instruction>${prompt}</instruction>\n\n<text>${selectionText}</text>`
        }
      ]
    }, { signal: abortController.signal })

    const textBlock = response.content.find(b => b.type === 'text') as Anthropic.Messages.TextBlock | undefined
    const newText = (textBlock?.text ?? '').trim()
    if (!newText) {
      throw createError({ statusCode: 502, message: 'Claude returned empty response' })
    }

    // Resolve selection positions. If relative positions are provided, prefer those
    // (they survive concurrent edits). Otherwise fall back to raw indices.
    let from = selectionFrom
    let to = selectionTo
    try {
      if (body.relFrom && body.relTo) {
        const relFrom = Y.createRelativePositionFromJSON(body.relFrom as any)
        const relTo = Y.createRelativePositionFromJSON(body.relTo as any)
        const absFrom = Y.createAbsolutePositionFromRelativePosition(relFrom, aiSession.ydoc)
        const absTo = Y.createAbsolutePositionFromRelativePosition(relTo, aiSession.ydoc)
        if (absFrom && absTo && absTo.index > absFrom.index) {
          from = absFrom.index
          to = absTo.index
        }
      }
    } catch {
      // fall back to raw indices
    }

    // Sanity check: the selection text should still match what's in the doc.
    // If it drifted too far, refuse to apply (don't overwrite the wrong range).
    const docText = aiSession.ytext.toString()
    const currentSlice = docText.slice(from, to)
    if (currentSlice !== selectionText) {
      // Try a best-effort fallback: find the exact selection text in the doc once
      const idx = docText.indexOf(selectionText)
      const lastIdx = docText.lastIndexOf(selectionText)
      if (idx >= 0 && idx === lastIdx) {
        from = idx
        to = idx + selectionText.length
      } else {
        throw createError({
          statusCode: 409,
          message: 'Selection has moved — please re-select and try again.'
        })
      }
    }

    aiSession.updateStatus('editing', 'Applying rewrite…')
    const origin = `ai:claude:${sessionId}`
    aiSession.ydoc.transact(() => {
      aiSession!.ytext.delete(from, to - from)
      aiSession!.ytext.insert(from, newText)
    }, origin)

    aiSession.updateStatus('done', 'Done')
    return { success: true, sessionId }
  } catch (e: any) {
    if (aiSession) aiSession.updateStatus('error', `Error: ${e.message}`)
    throw e
  } finally {
    clearTimeout(deadlineTimer)
    // Brief pause so the "done" status is visible to clients
    await new Promise((r) => setTimeout(r, 300))
    if (aiSession) await aiSession.destroy()
    removeAiSession(sessionId)
  }
})
