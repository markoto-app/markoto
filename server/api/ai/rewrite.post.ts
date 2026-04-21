import { GoogleGenAI } from '@google/genai'
import { nanoid } from 'nanoid'
import { findUserNameById } from '../../repos/users'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { resolveSelection } from '../../utils/agentic/resolveSelection'

import { MARKDOWN_REFERENCE } from '../../utils/agentic/markdownReference'

const REWRITE_SYSTEM = `Rewrite the text inside <text>...</text> according to the instruction inside <instruction>...</instruction>.

The full document is provided inside <document>...</document> for context — use it to match tone, style, and terminology, but rewrite ONLY the selection. Do not reproduce surrounding content.

Reply with ONLY the rewritten text — no preamble, no commentary, no markdown fences, no quotation marks wrapping the whole thing. Match the register and length of the original unless the instruction explicitly asks otherwise.

${MARKDOWN_REFERENCE}`

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name
  const config = useRuntimeConfig()

  if (!config.google.apiKey) {
    throw createError({ statusCode: 500, message: 'Google API key not configured' })
  }

  if (!(await checkRateLimit('ai-rewrite', String(userId), 30, 60 * 60 * 1000))) {
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
  if (
    typeof selectionFrom !== 'number'
    || typeof selectionTo !== 'number'
    || !Number.isInteger(selectionFrom)
    || !Number.isInteger(selectionTo)
    || selectionFrom < 0
    || selectionTo <= selectionFrom
  ) {
    throw createError({ statusCode: 400, message: 'Invalid selection range' })
  }

  await requireDocEditAccess(docId, userId)

  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706'

  const sessionId = nanoid(12)
  const abortController = new AbortController()

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

  const deadlineTimer = setTimeout(() => abortController.abort(), 30_000)

  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  try {
    aiSession = await createAiSession(docId, {
      sessionId,
      initiatorName,
      initiatorUserId: userId,
      initiatorColor,
      prompt: `(rewrite) ${prompt}`,
      kind: 'rewrite'
    }, abortController.signal)

    aiSession.updateStatus('thinking', 'Rewriting…')

    // Pull the current document for context. Cap to avoid runaway token usage on huge docs;
    // the selection itself is also included explicitly in <text> so the model can't miss it.
    const MAX_DOC_CONTEXT = 40000
    let documentContext = aiSession.ytext.toString()
    if (documentContext.length > MAX_DOC_CONTEXT) {
      // Keep a window around the selection
      const halfWindow = MAX_DOC_CONTEXT / 2
      const start = Math.max(0, selectionFrom - halfWindow)
      const end = Math.min(documentContext.length, selectionTo + halfWindow)
      documentContext = (start > 0 ? '…' : '') + documentContext.slice(start, end) + (end < documentContext.length ? '…' : '')
    }

    const ai = new GoogleGenAI({ apiKey: config.google.apiKey })
    const response = await ai.models.generateContent({
      model: config.google.rewriteModel,
      contents: [
        {
          role: 'user',
          parts: [{
            text: `<document>${documentContext}</document>\n\n<instruction>${prompt}</instruction>\n\n<text>${selectionText}</text>`
          }]
        }
      ],
      config: {
        systemInstruction: REWRITE_SYSTEM,
        // Bound output so a runaway response can't exceed 4× selection length.
        maxOutputTokens: Math.min(4096, selectionText.length * 4 + 200),
        abortSignal: abortController.signal
      }
    })

    const newText = (response.text ?? '').trim()
    if (!newText) {
      throw createError({ statusCode: 502, message: 'AI returned empty response' })
    }

    // Resolve which span to rewrite. Pure helper — walks the
    // RelativePosition → raw → indexOf fallback chain and returns a
    // definite (from, to) or flags the selection as moved. See
    // `resolveSelection.ts` for the full reasoning.
    const resolved = resolveSelection(aiSession.ydoc, aiSession.ytext, {
      selectionText,
      selectionFrom,
      selectionTo,
      relFrom: body.relFrom,
      relTo: body.relTo
    })
    if (!resolved.ok) {
      throw createError({
        statusCode: 409,
        message: 'Selection has moved — please re-select and try again.'
      })
    }
    const { from, to } = resolved

    aiSession.updateStatus('editing', 'Applying rewrite…')
    const origin = `ai:assistant:${sessionId}`
    aiSession.ydoc.transact(() => {
      aiSession!.ytext.delete(from, to - from)
      aiSession!.ytext.insert(from, newText)
    }, origin)

    aiSession.updateStatus('done', 'Done')
    return { success: true, sessionId }
  } catch (e) {
    if (aiSession) aiSession.updateStatus('error', `Error: ${e instanceof Error ? e.message : 'unknown'}`)
    throw e
  } finally {
    clearTimeout(deadlineTimer)
    // Brief pause so the "done" status is visible to clients
    await new Promise(r => setTimeout(r, 300))
    if (aiSession) await aiSession.destroy()
    await removeAiSession(sessionId)
  }
})
